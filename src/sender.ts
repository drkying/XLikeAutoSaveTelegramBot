import type { Env, MediaRecord } from "./types";
import { logInfo, logWarn, serializeError } from "./observability";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
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

export interface SentMediaResult {
  mediaId?: number;
  fileId?: string | null;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_URL_VIDEO_LIMIT_BYTES = 50 * 1024 * 1024;
const MULTIPART_CHUNK_SEPARATOR = "\r\n";

function telegramApiUrl(env: Env, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getPreferredMediaSource(media: MediaRecord): string | null {
  return media.telegram_file_id ?? media.r2_public_url ?? media.x_original_url ?? null;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function safeFilenameFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").pop();
    if (last) {
      return last.replace(/[^A-Za-z0-9._-]+/g, "_");
    }
  } catch {
    // Ignore malformed URLs and fall back to a generated name.
  }

  return fallback;
}

async function probeRemoteFileSize(source: string): Promise<number | null> {
  try {
    const response = await fetch(source, { method: "HEAD" });
    if (!response.ok) {
      return null;
    }

    const header = response.headers.get("content-length");
    if (!header) {
      return null;
    }

    const value = Number(header);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
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

async function callTelegramApiStream<T>(
  env: Env,
  method: string,
  requestFactory: () => Promise<RequestInit>,
  retries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const init = await requestFactory();
      const response = await fetch(telegramApiUrl(env, method), {
        method: "POST",
        ...init,
      });

      const body = (await response.json()) as TelegramApiResponse<T>;
      if (response.ok && body.ok && body.result !== undefined) {
        return body.result;
      }

      logWarn("telegram.api.stream_response_not_ok", {
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
      logWarn("telegram.api.stream_retrying", {
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

function createMultipartVideoBody(
  chatId: number,
  caption: string | undefined,
  filename: string,
  contentType: string,
  mediaStream: ReadableStream<Uint8Array>,
): {
  boundary: string;
  body: ReadableStream<Uint8Array>;
} {
  const boundary = `----xLikeSaveBot${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const partsBefore = [
    `--${boundary}${MULTIPART_CHUNK_SEPARATOR}Content-Disposition: form-data; name="chat_id"${MULTIPART_CHUNK_SEPARATOR}${MULTIPART_CHUNK_SEPARATOR}${chatId}${MULTIPART_CHUNK_SEPARATOR}`,
    caption
      ? `--${boundary}${MULTIPART_CHUNK_SEPARATOR}Content-Disposition: form-data; name="caption"${MULTIPART_CHUNK_SEPARATOR}${MULTIPART_CHUNK_SEPARATOR}${caption}${MULTIPART_CHUNK_SEPARATOR}`
      : null,
    caption
      ? `--${boundary}${MULTIPART_CHUNK_SEPARATOR}Content-Disposition: form-data; name="parse_mode"${MULTIPART_CHUNK_SEPARATOR}${MULTIPART_CHUNK_SEPARATOR}MarkdownV2${MULTIPART_CHUNK_SEPARATOR}`
      : null,
    `--${boundary}${MULTIPART_CHUNK_SEPARATOR}Content-Disposition: form-data; name="supports_streaming"${MULTIPART_CHUNK_SEPARATOR}${MULTIPART_CHUNK_SEPARATOR}true${MULTIPART_CHUNK_SEPARATOR}`,
    `--${boundary}${MULTIPART_CHUNK_SEPARATOR}Content-Disposition: form-data; name="video"; filename="${filename}"${MULTIPART_CHUNK_SEPARATOR}Content-Type: ${contentType}${MULTIPART_CHUNK_SEPARATOR}${MULTIPART_CHUNK_SEPARATOR}`,
  ].filter((part): part is string => Boolean(part));
  const tail = `${MULTIPART_CHUNK_SEPARATOR}--${boundary}--${MULTIPART_CHUNK_SEPARATOR}`;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const part of partsBefore) {
          controller.enqueue(encoder.encode(part));
        }

        const reader = mediaStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          }
        } finally {
          reader.releaseLock();
        }

        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { boundary, body };
}

async function sendLargeVideoViaStream(
  env: Env,
  chatId: number,
  source: string,
  caption?: string,
): Promise<TelegramMessage> {
  return callTelegramApiStream<TelegramMessage>(env, "sendVideo", async () => {
    const mediaResponse = await fetch(source);
    if (!mediaResponse.ok || !mediaResponse.body) {
      throw new Error(`Unable to fetch large video stream from ${source}`);
    }

    const contentType = mediaResponse.headers.get("content-type") ?? "video/mp4";
    const filename = safeFilenameFromUrl(source, "video.mp4");
    const multipart = createMultipartVideoBody(
      chatId,
      caption,
      filename,
      contentType,
      mediaResponse.body as ReadableStream<Uint8Array>,
    );

    return {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    };
  });
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  });
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
): Promise<SentMediaResult> {
  const source = getPreferredMediaSource(media);
  if (!source) {
    throw new Error(`Media ${media.id ?? media.media_key ?? media.tweet_id} has no sendable source`);
  }

  let message: TelegramMessage;
  if (media.media_type === "photo") {
    message = await callTelegramApi<TelegramMessage>(env, "sendPhoto", {
      chat_id: chatId,
      photo: source,
      caption,
      parse_mode: caption ? "MarkdownV2" : undefined,
    });
  } else if (media.media_type === "animated_gif") {
    message = await callTelegramApi<TelegramMessage>(env, "sendAnimation", {
      chat_id: chatId,
      animation: source,
      caption,
      parse_mode: caption ? "MarkdownV2" : undefined,
    });
  } else {
    const fileSizeBytes =
      media.file_size_bytes ??
      (isHttpUrl(source) ? await probeRemoteFileSize(source) : null);

    if (isHttpUrl(source) && fileSizeBytes !== null && fileSizeBytes > TELEGRAM_URL_VIDEO_LIMIT_BYTES) {
      logInfo("telegram.video.large_stream_upload", {
        chat_id: chatId,
        media_id: media.id,
        tweet_id: media.tweet_id,
        file_size_bytes: fileSizeBytes,
      });
      message = await sendLargeVideoViaStream(env, chatId, source, caption);
    } else {
      message = await callTelegramApi<TelegramMessage>(env, "sendVideo", {
        chat_id: chatId,
        video: source,
        caption,
        parse_mode: caption ? "MarkdownV2" : undefined,
      });
    }
  }

  return {
    mediaId: media.id,
    fileId: extractFileId(message),
  };
}

async function sendMediaGroup(
  env: Env,
  chatId: number,
  caption: string,
  mediaItems: MediaRecord[],
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
      parse_mode: index === 0 ? "MarkdownV2" : undefined,
    };
  });

  const messages = await callTelegramApi<TelegramMessage[]>(env, "sendMediaGroup", {
    chat_id: chatId,
    media: payload,
  });

  return mediaItems.map((media, index) => ({
    mediaId: media.id,
    fileId: messages[index] ? extractFileId(messages[index]) : null,
  }));
}

export async function sendTweetMessage(
  env: Env,
  chatId: number,
  markdown: string,
  mediaItems: MediaRecord[],
): Promise<SentMediaResult[]> {
  if (mediaItems.length === 0) {
    await sendMessage(env, chatId, markdown);
    return [];
  }

  if (
    mediaItems.length > 1 &&
    mediaItems.every((media) => media.media_type === "photo" || media.media_type === "video")
  ) {
    return sendMediaGroup(env, chatId, markdown, mediaItems);
  }

  const results: SentMediaResult[] = [];
  for (let index = 0; index < mediaItems.length; index += 1) {
    const media = mediaItems[index];
    const result = await sendMediaRecord(env, chatId, media, index === 0 ? markdown : undefined);
    results.push(result);
  }
  return results;
}
