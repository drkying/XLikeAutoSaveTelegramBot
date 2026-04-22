import type { Env, MediaRecord, MediaStorageStatus } from "./types";

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
}

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
    const response = await fetchMediaWithRetry(
      mediaItem.x_original_url,
      options.fetchInit,
    );
    const fileSize = readContentLength(response.headers.get("content-length"));
    const exceedsTelegramVideoLimit =
      mediaItem.media_type === "video" &&
      typeof fileSize === "number" &&
      fileSize > 50 * 1024 * 1024;
    const contentType = response.headers.get("content-type") ?? mediaItem.content_type ?? inferContentType(mediaItem);
    const r2Key = options.r2Key ?? buildMediaR2Key(mediaItem, options, contentType);
    const body = response.body ?? await response.arrayBuffer();
    const upload = await uploadToR2(env, r2Key, body, contentType, {
      tweetId: mediaItem.tweet_id,
      mediaKey: mediaItem.media_key,
      mediaType: mediaItem.media_type,
    });

    return {
      ...mediaItem,
      r2_key: upload.key,
      r2_public_url: upload.publicUrl,
      file_size_bytes: mediaItem.file_size_bytes ?? fileSize ?? null,
      content_type: contentType ?? mediaItem.content_type ?? null,
      storage_status:
        exceedsTelegramVideoLimit && !mediaItem.telegram_file_id
          ? "r2"
          : resolveSuccessStatus(mediaItem),
    };
  } catch {
    return {
      ...mediaItem,
      storage_status: resolveFailureStatus(mediaItem),
    };
  }
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
        throw error;
      }

      await sleep(Math.min(500 * (2 ** (attempt - 1)), 8_000));
    }
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
