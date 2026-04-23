import type {
  MediaRecord,
  MediaStorageStatus,
  XIncludes,
  XMedia,
  XMediaVariant,
  XTweet,
  XUrlEntity,
  XUser,
} from "./types";
import { DEFAULT_LANGUAGE, t, type Language } from "./i18n";

const MARKDOWN_V2_SPECIALS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIALS, "\\$1");
}

export function expandTcoUrls(text: string, entities?: XTweet["entities"]): string {
  const urls = [...(entities?.urls ?? [])]
    .filter((entity) => Number.isInteger(entity.start) && Number.isInteger(entity.end))
    .sort((left, right) => left.start - right.start);

  if (urls.length === 0) {
    return text;
  }

  const codePoints = Array.from(text);
  const output: string[] = [];
  let cursor = 0;

  for (const entity of urls) {
    const start = clamp(entity.start, 0, codePoints.length);
    const end = clamp(entity.end, start, codePoints.length);
    if (start < cursor) {
      continue;
    }

    output.push(codePoints.slice(cursor, start).join(""));
    output.push(resolveExpandedUrl(entity));
    cursor = end;
  }

  output.push(codePoints.slice(cursor).join(""));
  return output.join("");
}

export function tweetToMarkdown(
  tweet: XTweet,
  includes?: XIncludes,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const author = findTweetAuthor(tweet, includes);
  const displayName = author?.name ?? author?.username ?? tweet.author_id;
  const username = author?.username ?? tweet.author_id;
  const createdAt = formatTweetTimestamp(tweet.created_at, language);
  const expandedText = expandTcoUrls(tweet.text, tweet.entities).trim() || t(language, "tweet_no_text");
  const tweetUrl = buildTweetUrl(tweet, author);

  return [
    `🔖 *${escapeMarkdownV2(displayName)}* \\(@${escapeMarkdownV2(username)}\\)`,
    `📅 ${escapeMarkdownV2(createdAt)}`,
    "",
    escapeMarkdownV2(expandedText),
    "",
    `🔗 [${escapeMarkdownV2(t(language, "tweet_view_original"))}](${escapeMarkdownLinkUrl(tweetUrl)})`,
  ].join("\n");
}

export function buildTweetFallbackMarkdown(
  markdown: string,
  mediaItems: MediaRecord[],
  language: Language = DEFAULT_LANGUAGE,
): string {
  const mediaLinks = mediaItems
    .map((media, index) => buildR2FallbackLink(media, index, language))
    .filter((value): value is string => Boolean(value));

  if (mediaLinks.length === 0) {
    return markdown;
  }

  const { head, body, tail } = splitTweetMarkdown(markdown);
  const replacement = replaceTrailingBodyUrls(body, mediaLinks);
  const finalBody = replacement.remainingLinks.length === 0
    ? replacement.body
    : appendFallbackLinksToBody(replacement.body, replacement.remainingLinks, language);

  return [head, finalBody, tail].filter((part) => part.length > 0).join("\n\n");
}

export function extractMedia(tweet: XTweet, includes?: XIncludes): MediaRecord[] {
  const mediaKeys = tweet.attachments?.media_keys ?? [];
  const mediaMap = new Map<string, XMedia>(
    (includes?.media ?? []).map((media) => [media.media_key, media]),
  );
  const seen = new Set<string>();
  const output: MediaRecord[] = [];

  for (const mediaKey of mediaKeys) {
    if (seen.has(mediaKey)) {
      continue;
    }
    seen.add(mediaKey);

    const media = mediaMap.get(mediaKey);
    if (!media) {
      continue;
    }

    const resolved = resolveMediaSource(media);
    const storageStatus: MediaStorageStatus = resolved.url ? "pending" : "failed";

    output.push({
      tweet_id: tweet.id,
      media_key: media.media_key,
      media_type: media.type,
      x_original_url: resolved.url ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      duration_ms: media.duration_ms ?? null,
      content_type: resolved.contentType ?? null,
      bitrate: resolved.bitrate ?? null,
      storage_status: storageStatus,
    });
  }

  return output;
}

export function findTweetAuthor(tweet: XTweet, includes?: XIncludes): XUser | undefined {
  return includes?.users?.find((user) => user.id === tweet.author_id);
}

function resolveExpandedUrl(entity: XUrlEntity): string {
  return entity.expanded_url ?? entity.display_url ?? entity.url;
}

function resolveMediaSource(
  media: XMedia,
): { url?: string; contentType?: string; bitrate?: number } {
  if (media.type === "photo") {
    const url = media.url ?? media.preview_image_url;
    return {
      url,
      contentType: inferContentTypeFromUrl(url, media.type),
    };
  }

  const selectedVariant = selectBestVariant(media.type, media.variants);
  const url = selectedVariant?.url;

  return {
    url,
    contentType: selectedVariant?.content_type ?? inferContentTypeFromUrl(url, media.type),
    bitrate: selectedVariant?.bit_rate,
  };
}

function selectBestVariant(
  mediaType: XMedia["type"],
  variants?: XMediaVariant[],
): XMediaVariant | undefined {
  if (!variants || variants.length === 0) {
    return undefined;
  }

  const preferred = variants.filter((variant) => variant.content_type === "video/mp4");
  const pool = preferred.length > 0 ? preferred : variants;

  return [...pool].sort((left, right) => {
    const leftBitrate = left.bit_rate ?? (mediaType === "animated_gif" ? 1 : 0);
    const rightBitrate = right.bit_rate ?? (mediaType === "animated_gif" ? 1 : 0);
    return rightBitrate - leftBitrate;
  })[0];
}

function buildTweetUrl(tweet: XTweet, author?: XUser): string {
  if (author?.username) {
    return `https://x.com/${author.username}/status/${tweet.id}`;
  }

  return `https://x.com/i/web/status/${tweet.id}`;
}

function formatTweetTimestamp(value: string | undefined, language: Language): string {
  if (!value) {
    return t(language, "tweet_unknown_time");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function escapeMarkdownLinkUrl(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function getMediaLinkLabel(media: MediaRecord, index: number, language: Language): string {
  const labelByType: Record<MediaRecord["media_type"], string> = {
    photo: t(language, "tweet_media_photo"),
    video: t(language, "tweet_media_video"),
    animated_gif: t(language, "tweet_media_gif"),
  };

  return `${labelByType[media.media_type]} ${index + 1}`;
}

function getMediaLinkPrefix(mediaType: MediaRecord["media_type"]): string {
  switch (mediaType) {
    case "photo":
      return "🖼";
    case "animated_gif":
      return "🎞";
    case "video":
    default:
      return "🎬";
  }
}

function buildR2FallbackLink(media: MediaRecord, index: number, language: Language): string | null {
  if (!media.r2_public_url) {
    return null;
  }

  const label = t(language, "tweet_media_r2_file", {
    label: getMediaLinkLabel(media, index, language),
  });
  return `${getMediaLinkPrefix(media.media_type)} [${escapeMarkdownV2(label)}](${escapeMarkdownLinkUrl(media.r2_public_url)})`;
}

function splitTweetMarkdown(markdown: string): { head: string; body: string; tail: string } {
  const sections = markdown.split("\n\n");
  if (sections.length === 0) {
    return {
      head: "",
      body: "",
      tail: "",
    };
  }

  const lastSection = sections[sections.length - 1] ?? "";
  const tail = /^🔗 \[(?:查看原推|View original post)\]/u.test(lastSection) ? sections.pop() ?? "" : "";
  const head = sections.shift() ?? "";
  const body = sections.join("\n\n");

  return {
    head,
    body,
    tail,
  };
}

function replaceTrailingBodyUrls(
  body: string,
  mediaLinks: string[],
): { body: string; remainingLinks: string[] } {
  if (!body) {
    return {
      body,
      remainingLinks: [...mediaLinks],
    };
  }

  const matches = [...body.matchAll(/https?:\/\/(?:\\.|[^\s])+/g)];
  if (matches.length === 0) {
    return {
      body,
      remainingLinks: [...mediaLinks],
    };
  }

  const remainingLinks = [...mediaLinks];
  const selectedMatches = matches.slice(-remainingLinks.length);
  let cursor = body.length;
  const output: string[] = [];

  for (let index = selectedMatches.length - 1; index >= 0; index -= 1) {
    const match = selectedMatches[index];
    const replacement = remainingLinks.pop();
    if (!replacement || match.index === undefined) {
      continue;
    }

    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    output.unshift(body.slice(matchEnd, cursor));
    output.unshift(replacement);
    cursor = matchStart;
  }

  output.unshift(body.slice(0, cursor));
  return {
    body: output.join(""),
    remainingLinks,
  };
}

function appendFallbackLinksToBody(body: string, mediaLinks: string[], language: Language): string {
  const trimmedBody = body.trim();
  if (
    !trimmedBody ||
    trimmedBody === t(language, "tweet_no_text") ||
    trimmedBody === t("en", "tweet_no_text") ||
    trimmedBody === t("zh", "tweet_no_text")
  ) {
    return mediaLinks.join("\n");
  }

  return [body, ...mediaLinks].join("\n");
}

function inferContentTypeFromUrl(
  url: string | undefined,
  mediaType: XMedia["type"],
): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    const format = parsed.searchParams.get("format");
    if (format) {
      return mapExtensionToContentType(format);
    }

    const extension = parsed.pathname.split(".").pop();
    if (extension) {
      return mapExtensionToContentType(extension);
    }
  } catch {
    // Fall through to media-type defaults when the upstream URL is malformed.
  }

  if (mediaType === "photo") {
    return "image/jpeg";
  }

  return "video/mp4";
}

function mapExtensionToContentType(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "m3u8":
      return "application/x-mpegURL";
    default:
      return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
