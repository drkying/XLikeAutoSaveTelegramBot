import type { Env, MediaRecord } from "./types";
import { logInfo, logWarn, serializeError } from "./observability";
import { getTelegramApiBase, getTelegramMediaSizeLimitBytes } from "./telegram-config";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFile {
  file_id: string;
  file_path?: string;
}

interface TelegramPhotoSize {
  file_id: string;
}

interface TelegramVideo {
  file_id: string;
}

interface TelegramAnimation {
  file_id: string;
}

interface TelegramMessage {
  message_id: number;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  animation?: TelegramAnimation;
}

interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
}

export interface SentMediaResult {
  mediaId?: number;
  fileId?: string | null;
  filePath?: string | null;
  fileUrl?: string | null;
}

export interface SendTweetMessageResult {
  sentResults: SentMediaResult[];
  fallbackMedia: MediaRecord[];
  captionSent: boolean;
}

export interface TelegramSendOptions {
  messageThreadId?: number | null;
}

export class TelegramMediaSendError extends Error {
  constructor(
    readonly media: MediaRecord,
    message: string,
    readonly needsR2Fallback = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TelegramMediaSendError";
  }
}

function telegramApiUrl(env: Env, method: string): string {
  return `${getTelegramApiBase(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getPreferredMediaSource(media: MediaRecord): string | null {
  return media.telegram_file_id ?? media.x_original_url ?? media.r2_public_url ?? null;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function withThreadTarget(
  payload: Record<string, unknown>,
  options?: TelegramSendOptions,
): Record<string, unknown> {
  if (options?.messageThreadId !== undefined && options.messageThreadId !== null) {
    return {
      ...payload,
      message_thread_id: options.messageThreadId,
    };
  }

  return payload;
}

function normalizeForumTopicName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const normalized = Array.from(trimmed).slice(0, 128).join("");
  return normalized || "Unknown author";
}

function extractFileId(message: TelegramMessage): string | null {
  if (message.photo?.length) {
    return message.photo[message.photo.length - 1]?.file_id ?? null;
  }
  if (message.video) {
    return message.video.file_id;
  }
  if (message.animation) {
    return message.animation.file_id;
  }
  return null;
}

function buildTelegramFileUrl(env: Env, filePath: string): string {
  return `${getTelegramApiBase(env)}/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
}

async function resolveTelegramFileMetadata(
  env: Env,
  fileId: string | null,
): Promise<{ filePath?: string | null; fileUrl?: string | null }> {
  if (!fileId) {
    return {};
  }

  const file = await callTelegramApi<TelegramFile>(env, "getFile", {
    file_id: fileId,
  });
  if (!file.file_path) {
    return {};
  }

  return {
    filePath: file.file_path,
    fileUrl: buildTelegramFileUrl(env, file.file_path),
  };
}

async function callTelegramApi<T>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
  retries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(telegramApiUrl(env, method), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as TelegramApiResponse<T>;
      if (response.ok && body.ok && body.result !== undefined) {
        return body.result;
      }

      logWarn("telegram.api.response_not_ok", {
        method,
        attempt: attempt + 1,
        status: response.status,
        description: body.description,
      });

      throw new Error(body.description ?? `Telegram API ${method} failed with ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) {
        break;
      }
      logWarn("telegram.api.retrying", {
        method,
        attempt: attempt + 1,
        max_retries: retries,
        ...serializeError(error),
      });
      await wait(250 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Telegram API ${method} failed`);
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options?: TelegramSendOptions,
): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>(env, "sendMessage", withThreadTarget({
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  }, options));
}

export async function notifyUser(env: Env, chatId: number, message: string): Promise<void> {
  await callTelegramApi<TelegramMessage>(env, "sendMessage", {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
  });
}

export async function notifyAdmin(env: Env, message: string): Promise<void> {
  if (!env.ADMIN_CHAT_ID) {
    return;
  }

  const chatId = Number(env.ADMIN_CHAT_ID);
  if (!Number.isSafeInteger(chatId)) {
    return;
  }

  await notifyUser(env, chatId, message);
}

export async function sendMediaRecord(
  env: Env,
  chatId: number,
  media: MediaRecord,
  caption?: string,
  options?: TelegramSendOptions,
): Promise<SentMediaResult> {
  const source = getPreferredMediaSource(media);
  if (!source) {
    throw new Error(`Media ${media.id ?? media.media_key ?? media.tweet_id} has no sendable source`);
  }
  if (
    !media.telegram_file_id &&
    media.file_size_bytes !== null &&
    media.file_size_bytes !== undefined &&
    media.file_size_bytes > getTelegramMediaSizeLimitBytes(env)
  ) {
    throw new TelegramMediaSendError(
      media,
      `Media ${media.id ?? media.media_key ?? media.tweet_id} exceeds Telegram direct-send limit`,
      true,
    );
  }

  let message: TelegramMessage;
  try {
    if (media.media_type === "photo") {
      message = await callTelegramApi<TelegramMessage>(env, "sendPhoto", withThreadTarget({
        chat_id: chatId,
        photo: source,
        caption,
        parse_mode: caption ? "MarkdownV2" : undefined,
      }, options));
    } else if (media.media_type === "animated_gif") {
      message = await callTelegramApi<TelegramMessage>(env, "sendAnimation", withThreadTarget({
        chat_id: chatId,
        animation: source,
        caption,
        parse_mode: caption ? "MarkdownV2" : undefined,
      }, options));
    } else {
      message = await callTelegramApi<TelegramMessage>(env, "sendVideo", withThreadTarget({
        chat_id: chatId,
        video: source,
        caption,
        parse_mode: caption ? "MarkdownV2" : undefined,
      }, options));
    }
  } catch (error) {
    if (shouldFallbackToR2(media, source, error)) {
      throw new TelegramMediaSendError(
        media,
        error instanceof Error ? error.message : String(error),
        true,
        error,
      );
    }
    throw error;
  }

  const fileId = extractFileId(message);
  const fileMetadata = await resolveTelegramFileMetadata(env, fileId);
  return {
    mediaId: media.id,
    fileId,
    filePath: fileMetadata.filePath ?? null,
    fileUrl: fileMetadata.fileUrl ?? null,
  };
}

async function sendMediaGroup(
  env: Env,
  chatId: number,
  caption: string | undefined,
  mediaItems: MediaRecord[],
  options?: TelegramSendOptions,
): Promise<SentMediaResult[]> {
  logInfo("telegram.media_group.sending", {
    chat_id: chatId,
    media_count: mediaItems.length,
    tweet_id: mediaItems[0]?.tweet_id ?? null,
  });
  const payload = mediaItems.map((media, index) => {
    const source = getPreferredMediaSource(media);
    if (!source) {
      throw new Error(`Media ${media.id ?? media.media_key ?? media.tweet_id} has no sendable source`);
    }

    return {
      type: media.media_type === "photo" ? "photo" : "video",
      media: source,
      caption: index === 0 ? caption : undefined,
      parse_mode: index === 0 && caption ? "MarkdownV2" : undefined,
    };
  });

  const messages = await callTelegramApi<TelegramMessage[]>(env, "sendMediaGroup", withThreadTarget({
    chat_id: chatId,
    media: payload,
  }, options));

  return Promise.all(mediaItems.map(async (media, index) => {
    const fileId = messages[index] ? extractFileId(messages[index]) : null;
    const fileMetadata = await resolveTelegramFileMetadata(env, fileId);
    return {
      mediaId: media.id,
      fileId,
      filePath: fileMetadata.filePath ?? null,
      fileUrl: fileMetadata.fileUrl ?? null,
    };
  }));
}

export async function sendTweetMessage(
  env: Env,
  chatId: number,
  markdown: string | undefined,
  mediaItems: MediaRecord[],
  options?: TelegramSendOptions,
): Promise<SendTweetMessageResult> {
  if (mediaItems.length === 0) {
    if (markdown) {
      await sendMessage(env, chatId, markdown, options);
    }
    return {
      sentResults: [],
      fallbackMedia: [],
      captionSent: false,
    };
  }

  if (
    shouldSendViaMediaGroup(mediaItems)
  ) {
    try {
      return {
        sentResults: await sendMediaGroup(env, chatId, markdown, mediaItems, options),
        fallbackMedia: [],
        captionSent: Boolean(markdown),
      };
    } catch (error) {
      if (!isRecoverableMediaGroupError(error)) {
        throw error;
      }

      logWarn("telegram.media_group.fallback_to_single", {
        chat_id: chatId,
        media_count: mediaItems.length,
        tweet_id: mediaItems[0]?.tweet_id ?? null,
        ...serializeError(error),
      });
    }
  }

  const results: SentMediaResult[] = [];
  const fallbackMedia: MediaRecord[] = [];
  let captionSent = false;
  for (let index = 0; index < mediaItems.length; index += 1) {
    const media = mediaItems[index];
    try {
      const result = await sendMediaRecord(
        env,
        chatId,
        media,
        !captionSent ? markdown : undefined,
        options,
      );
      results.push(result);
      captionSent ||= Boolean(markdown);
    } catch (error) {
      if (!(error instanceof TelegramMediaSendError) || !error.needsR2Fallback) {
        throw error;
      }

      fallbackMedia.push(media);
      logWarn("telegram.media.single.defer_to_r2", {
        chat_id: chatId,
        media_id: media.id ?? null,
        tweet_id: media.tweet_id,
        media_type: media.media_type,
        ...serializeError(error),
      });
    }
  }
  return {
    sentResults: results,
    fallbackMedia,
    captionSent,
  };
}

export async function createForumTopic(
  env: Env,
  chatId: number,
  name: string,
): Promise<number> {
  const topic = await callTelegramApi<TelegramForumTopic>(env, "createForumTopic", {
    chat_id: chatId,
    name: normalizeForumTopicName(name),
  });

  return topic.message_thread_id;
}

function shouldSendViaMediaGroup(mediaItems: MediaRecord[]): boolean {
  return (
    mediaItems.length > 1 &&
    mediaItems.every((media) => media.media_type === "photo" || media.media_type === "video")
  );
}

function isRecoverableMediaGroupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isMediaUrlSendErrorMessage(message);
}

function shouldFallbackToR2(media: MediaRecord, source: string, error: unknown): boolean {
  if (media.telegram_file_id || !isHttpUrl(source)) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return isMediaUrlSendErrorMessage(message);
}

function isMediaUrlSendErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("webpage_media_empty") ||
    normalized.includes("failed to get http url content") ||
    normalized.includes("wrong file identifier/http url specified") ||
    normalized.includes("wrong type of the web page content") ||
    normalized.includes("file is too big") ||
    normalized.includes("request entity too large")
  );
}
