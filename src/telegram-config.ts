import type { Env } from "./types";

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
const OFFICIAL_TELEGRAM_API_HOST = "api.telegram.org";
const OFFICIAL_TELEGRAM_MEDIA_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
const SELF_HOSTED_TELEGRAM_MEDIA_SIZE_LIMIT_BYTES = 2000 * 1024 * 1024;

export function getTelegramApiBase(env: Pick<Env, "TELEGRAM_API_BASE">): string {
  const configured = env.TELEGRAM_API_BASE?.trim() || DEFAULT_TELEGRAM_API_BASE;
  const withProtocol = configured.startsWith("http://") || configured.startsWith("https://")
    ? configured
    : `https://${configured}`;
  return withProtocol.replace(/\/+$/, "");
}

export function getTelegramMediaSizeLimitBytes(env: Pick<Env, "TELEGRAM_API_BASE">): number {
  return isOfficialTelegramApiBase(getTelegramApiBase(env))
    ? OFFICIAL_TELEGRAM_MEDIA_SIZE_LIMIT_BYTES
    : SELF_HOSTED_TELEGRAM_MEDIA_SIZE_LIMIT_BYTES;
}

export function isOfficialTelegramApiBase(apiBase: string): boolean {
  try {
    return new URL(apiBase).hostname.toLowerCase() === OFFICIAL_TELEGRAM_API_HOST;
  } catch {
    return false;
  }
}
