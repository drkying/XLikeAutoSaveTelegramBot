import type { Env, MediaRecord, MediaStorageStatus } from "./types";
import { logInfo, logWarn, serializeError } from "./observability";

type R2UploadBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream;

interface UploadMetadata {
  tweetId?: string;
  mediaKey?: string | null;
  mediaType?: string;
}

export interface R2UploadResult {
  key: string;
  publicUrl: string | null;
}

export interface ProcessMediaItemOptions {
  accountId?: string;
  keyPrefix?: string;
  r2Key?: string;
  fetchInit?: RequestInit;
  onlyWhenExceedsTelegramLimit?: boolean;
  failureStatus?: MediaStorageStatus;
}

export const TELEGRAM_MEDIA_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

export async function uploadToR2(
  env: Env,
  key: string,
  body: R2UploadBody,
  contentType?: string | null,
  metadata: UploadMetadata = {},
): Promise<R2UploadResult> {
  const options: R2PutOptions = {
    customMetadata: compactMetadata(metadata),
  };

  if (contentType) {
    options.httpMetadata = { contentType };
  }

  await env.R2.put(key, body, options);
  logInfo("r2.upload.completed", {
    key,
    has_public_url: Boolean(env.R2_PUBLIC_DOMAIN),
    tweet_id: metadata.tweetId ?? null,
    media_key: metadata.mediaKey ?? null,
    media_type: metadata.mediaType ?? null,
  });

  return {
    key,
    publicUrl: getR2PublicUrl(env, key),
  };
}

export function getR2PublicUrl(env: Env, key: string): string | null {
  const rawBase = env.R2_PUBLIC_DOMAIN?.trim();
  if (!rawBase) {
    return null;
  }

  const normalizedBase = rawBase.startsWith("http://") || rawBase.startsWith("https://")
    ? rawBase.replace(/\/+$/g, "")
    : `https://${rawBase.replace(/\/+$/g, "")}`;

  return `${normalizedBase}/${encodeR2KeyForUrl(key)}`;
}

export async function processMediaItem(
  env: Env,
  mediaItem: MediaRecord,
  options: ProcessMediaItemOptions = {},
): Promise<MediaRecord> {
  if (!mediaItem.x_original_url) {
    return {
      ...mediaItem,
      storage_status: resolveFailureStatus(mediaItem),
    };
  }

  try {
    const shouldProbeMetadata =
      options.onlyWhenExceedsTelegramLimit === true &&
      !mediaItem.telegram_file_id &&
      (mediaItem.file_size_bytes === null ||
        mediaItem.file_size_bytes === undefined ||
        mediaItem.content_type === null ||
        mediaItem.content_type === undefined);
    const metadata = shouldProbeMetadata
      ? await probeRemoteMediaMetadata(mediaItem.x_original_url, options.fetchInit)
      : {};
    const fileSize = mediaItem.file_size_bytes ?? metadata.contentLength;
    const contentType = metadata.contentType ?? mediaItem.content_type ?? inferContentType(mediaItem);
    const exceedsTelegramSizeLimit =
      !mediaItem.telegram_file_id &&
      (metadata.exceedsTelegramLimit === true ||
        (typeof fileSize === "number" && fileSize > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES));
    logInfo("media.process.started", {
      tweet_id: mediaItem.tweet_id,
      media_key: mediaItem.media_key ?? null,
      media_type: mediaItem.media_type,
      file_size_bytes: fileSize ?? mediaItem.file_size_bytes ?? null,
      exceeds_telegram_size_limit: exceedsTelegramSizeLimit,
      only_when_exceeds_telegram_limit: options.onlyWhenExceedsTelegramLimit === true,
    });

    if (options.onlyWhenExceedsTelegramLimit === true && !exceedsTelegramSizeLimit) {
      return {
        ...mediaItem,
        file_size_bytes: fileSize ?? mediaItem.file_size_bytes ?? null,
        content_type: contentType ?? mediaItem.content_type ?? null,
        storage_status: mediaItem.telegram_file_id ? "telegram" : mediaItem.storage_status,
      };
    }

    const response = await fetchMediaWithRetry(
      mediaItem.x_original_url,
      options.fetchInit,
    );
    const responseFileSize = readContentLength(response.headers.get("content-length")) ?? fileSize;
    const responseContentType =
      response.headers.get("content-type") ?? contentType ?? mediaItem.content_type ?? inferContentType(mediaItem);
    const r2Key = options.r2Key ?? buildMediaR2Key(mediaItem, options, responseContentType);
    const body = response.body ?? await response.arrayBuffer();
    const upload = await uploadToR2(env, r2Key, body, responseContentType, {
      tweetId: mediaItem.tweet_id,
      mediaKey: mediaItem.media_key,
      mediaType: mediaItem.media_type,
    });

    return {
      ...mediaItem,
      r2_key: upload.key,
      r2_public_url: upload.publicUrl,
      file_size_bytes: responseFileSize ?? mediaItem.file_size_bytes ?? null,
      content_type: responseContentType ?? mediaItem.content_type ?? null,
      storage_status:
        options.onlyWhenExceedsTelegramLimit === true && !mediaItem.telegram_file_id
          ? "r2"
          : resolveSuccessStatus(mediaItem),
    };
  } catch {
    logWarn("media.process.failed", {
      tweet_id: mediaItem.tweet_id,
      media_key: mediaItem.media_key ?? null,
      media_type: mediaItem.media_type,
      source_url: mediaItem.x_original_url,
    });
    return {
      ...mediaItem,
      storage_status: options.failureStatus ?? resolveFailureStatus(mediaItem),
    };
  }
}

export async function ensureMediaStoredInR2(
  env: Env,
  mediaItem: MediaRecord,
  options: ProcessMediaItemOptions = {},
): Promise<MediaRecord> {
  const existingPublicUrl =
    mediaItem.r2_public_url ?? (mediaItem.r2_key ? getR2PublicUrl(env, mediaItem.r2_key) : null);
  if (existingPublicUrl) {
    return {
      ...mediaItem,
      r2_public_url: existingPublicUrl,
      storage_status: mediaItem.telegram_file_id ? "telegram" : "r2",
    };
  }

  return processMediaItem(env, mediaItem, {
    ...options,
    onlyWhenExceedsTelegramLimit: false,
    failureStatus: "failed",
  });
}

export function buildMediaR2Key(
  mediaItem: MediaRecord,
  options: Pick<ProcessMediaItemOptions, "accountId" | "keyPrefix"> = {},
  contentType?: string | null,
): string {
  const segments = [sanitizeKeySegment(options.keyPrefix ?? "media")];
  if (options.accountId) {
    segments.push(sanitizeKeySegment(options.accountId));
  }
  segments.push(sanitizeKeySegment(mediaItem.tweet_id));

  const baseName = sanitizeKeySegment(
    mediaItem.media_key ?? `${mediaItem.media_type}-${mediaItem.id ?? "item"}`,
  );
  const extension = inferExtension(mediaItem, contentType);

  return `${segments.join("/")}/${baseName}.${extension}`;
}

async function fetchMediaWithRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }

      if (
        attempt > maxRetries ||
        !(response.status === 429 || (response.status >= 500 && response.status <= 599))
      ) {
        throw new Error(`Media fetch failed with ${response.status}.`);
      }

      await sleep(getRetryDelayMs(response, attempt));
    } catch (error) {
      if (attempt > maxRetries) {
        logWarn("media.fetch.failed", {
          url,
          attempt,
          ...serializeError(error),
        });
        throw error;
      }

      logWarn("media.fetch.retrying", {
        url,
        attempt,
        ...serializeError(error),
      });
      await sleep(Math.min(500 * (2 ** (attempt - 1)), 8_000));
    }
  }
}

async function probeRemoteMediaMetadata(
  url: string,
  init?: RequestInit,
): Promise<{
  contentLength?: number;
  contentType?: string | null;
  exceedsTelegramLimit?: boolean;
}> {
  const headMetadata = await probeRemoteMediaHeadMetadata(url, init);
  if (headMetadata.contentLength !== undefined) {
    return {
      ...headMetadata,
      exceedsTelegramLimit: headMetadata.contentLength > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES,
    };
  }

  const rangeMetadata = await probeRemoteMediaRangeMetadata(url, init);
  if (rangeMetadata.contentLength !== undefined) {
    return {
      ...rangeMetadata,
      exceedsTelegramLimit: rangeMetadata.contentLength > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES,
    };
  }

  return probeRemoteMediaStreamMetadata(url, init);
}

async function probeRemoteMediaHeadMetadata(
  url: string,
  init?: RequestInit,
): Promise<{ contentLength?: number; contentType?: string | null }> {
  try {
    const response = await fetch(url, {
      ...init,
      method: "HEAD",
    });
    if (!response.ok) {
      return {};
    }

    return {
      contentLength: readContentLength(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    logWarn("media.metadata_probe.failed", {
      url,
      ...serializeError(error),
    });
    return {};
  }
}

async function probeRemoteMediaRangeMetadata(
  url: string,
  init?: RequestInit,
): Promise<{ contentLength?: number; contentType?: string | null }> {
  try {
    const response = await fetch(url, withHeaders(init, {
      Range: "bytes=0-0",
    }));
    if (!response.ok) {
      return {};
    }

    const totalLength = readContentRangeTotal(response.headers.get("content-range"));
    return {
      contentLength: totalLength ?? readContentLength(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    logWarn("media.metadata_range_probe.failed", {
      url,
      ...serializeError(error),
    });
    return {};
  }
}

async function probeRemoteMediaStreamMetadata(
  url: string,
  init?: RequestInit,
): Promise<{
  contentLength?: number;
  contentType?: string | null;
  exceedsTelegramLimit?: boolean;
}> {
  try {
    const response = await fetchMediaWithRetry(url, init);
    const contentType = response.headers.get("content-type");
    const headerLength = readContentLength(response.headers.get("content-length"));
    if (headerLength !== undefined) {
      return {
        contentLength: headerLength,
        contentType,
        exceedsTelegramLimit: headerLength > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES,
      };
    }

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return {
        contentLength: buffer.byteLength,
        contentType,
        exceedsTelegramLimit: buffer.byteLength > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES,
      };
    }

    const reader = response.body.getReader();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return {
          contentLength: totalBytes,
          contentType,
        };
      }

      totalBytes += value.byteLength;
      if (totalBytes > TELEGRAM_MEDIA_SIZE_LIMIT_BYTES) {
        await cancelReader(reader);
        return {
          contentLength: totalBytes,
          contentType,
          exceedsTelegramLimit: true,
        };
      }
    }
  } catch (error) {
    logWarn("media.metadata_stream_probe.failed", {
      url,
      ...serializeError(error),
    });
    return {};
  }
}

function resolveSuccessStatus(mediaItem: MediaRecord): MediaStorageStatus {
  return mediaItem.telegram_file_id ? "telegram" : "r2";
}

function resolveFailureStatus(mediaItem: MediaRecord): MediaStorageStatus {
  if (mediaItem.telegram_file_id) {
    return "telegram";
  }

  if (mediaItem.x_original_url) {
    return "x_only";
  }

  return "failed";
}

function compactMetadata(metadata: UploadMetadata): Record<string, string> {
  const entries = Object.entries(metadata).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function encodeR2KeyForUrl(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function inferExtension(mediaItem: MediaRecord, contentType?: string | null): string {
  const byContentType = mapContentTypeToExtension(contentType ?? undefined);
  if (byContentType) {
    return byContentType;
  }

  const url = mediaItem.x_original_url;
  if (url) {
    try {
      const parsed = new URL(url);
      const format = parsed.searchParams.get("format");
      if (format) {
        return sanitizeExtension(format);
      }

      const extension = parsed.pathname.split(".").pop();
      if (extension) {
        return sanitizeExtension(extension);
      }
    } catch {
      // Ignore malformed source URLs and fall back to media type defaults.
    }
  }

  switch (mediaItem.media_type) {
    case "photo":
      return "jpg";
    case "animated_gif":
    case "video":
      return "mp4";
    default:
      return "bin";
  }
}

function inferContentType(mediaItem: MediaRecord): string | undefined {
  switch (mediaItem.media_type) {
    case "photo":
      return "image/jpeg";
    case "animated_gif":
    case "video":
      return "video/mp4";
    default:
      return undefined;
  }
}

function mapContentTypeToExtension(contentType?: string): string | undefined {
  if (!contentType) {
    return undefined;
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "application/x-mpegurl":
      return "m3u8";
    default:
      return undefined;
  }
}

function sanitizeExtension(extension: string): string {
  return extension.toLowerCase().replace(/[^a-z0-9]+/g, "") || "bin";
}

function readContentLength(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

function readContentRangeTotal(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const match = /^bytes\s+\d+-\d+\/(\d+)$/.exec(header.trim());
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function withHeaders(init: RequestInit | undefined, extraHeaders: Record<string, string>): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return {
    ...init,
    headers,
  };
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel("telegram_limit_exceeded");
  } catch {
    // Ignore cancellation failures from upstream streams.
  }
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1_000, 250), 30_000);
    }
  }

  return Math.min(500 * (2 ** (attempt - 1)), 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
