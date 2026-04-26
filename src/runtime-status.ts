import { getTelegramApiBase, getTelegramMediaSizeLimitBytes, isOfficialTelegramApiBase } from "./telegram-config";
import type { Env, MediaStorageStatus } from "./types";

interface CountRow {
  count: number;
}

interface MediaStatusRow {
  storage_status: MediaStorageStatus | null;
  count: number;
}

export async function buildRuntimeStatus(env: Env): Promise<Record<string, unknown>> {
  const telegramApiBase = getTelegramApiBase(env);
  const mediaLimitBytes = getTelegramMediaSizeLimitBytes(env);
  const [
    userCount,
    accountCount,
    activeAccountCount,
    tweetCount,
    authorCount,
    mediaStatusCounts,
    schemaStatus,
  ] = await Promise.all([
    countRows(env, "users"),
    countRows(env, "accounts"),
    countRows(env, "accounts", "is_active = 1"),
    countRows(env, "tweets"),
    countRows(env, "tweet_authors"),
    countMediaByStatus(env),
    inspectSchema(env),
  ]);

  return {
    ok: schemaStatus.ok,
    service: "x-like-save-bot",
    generatedAt: new Date().toISOString(),
    telegram: {
      apiBase: telegramApiBase,
      officialApi: isOfficialTelegramApiBase(telegramApiBase),
      customApi: !isOfficialTelegramApiBase(telegramApiBase),
      mediaDirectLimitBytes: mediaLimitBytes,
      mediaDirectLimitMb: Math.round(mediaLimitBytes / 1024 / 1024),
      botTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET),
      adminChatConfigured: Boolean(env.ADMIN_CHAT_ID),
    },
    cloudflare: {
      workersPaidEnabled: env.WORKERS_PAID_ENABLED ?? "false",
      appBaseUrl: env.APP_BASE_URL,
      r2PublicDomain: env.R2_PUBLIC_DOMAIN ?? null,
      r2PublicUrlConfigured: Boolean(env.R2_PUBLIC_DOMAIN),
      bindings: {
        kv: Boolean(env.KV),
        d1: Boolean(env.DB),
        r2: Boolean(env.R2),
      },
    },
    database: {
      schema: schemaStatus,
      counts: {
        users: userCount,
        accounts: accountCount,
        activeAccounts: activeAccountCount,
        tweets: tweetCount,
        authors: authorCount,
        mediaByStatus: mediaStatusCounts,
      },
    },
    polling: {
      cron: "*/5 * * * *",
    },
  };
}

export function isRuntimeStatusAuthorized(request: Request, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) {
    return true;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const statusSecret = request.headers.get("x-status-secret")?.trim();
  return bearer === env.WEBHOOK_SECRET || statusSecret === env.WEBHOOK_SECRET;
}

async function countRows(env: Env, table: string, where?: string): Promise<number> {
  const sql = `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const row = await env.DB.prepare(sql).first<CountRow>();
  return row?.count ?? 0;
}

async function countMediaByStatus(env: Env): Promise<Record<string, number>> {
  const result = await env.DB.prepare(
    `SELECT storage_status, COUNT(*) AS count
     FROM media
     GROUP BY storage_status`,
  ).all<MediaStatusRow>();

  return Object.fromEntries(
    (result.results ?? []).map((row) => [row.storage_status ?? "unknown", row.count]),
  );
}

async function inspectSchema(env: Env): Promise<{
  ok: boolean;
  missing: Record<string, string[]>;
}> {
  const required: Record<string, string[]> = {
    users: ["telegram_chat_id", "x_client_id", "x_client_secret", "credential_owner_account_id"],
    accounts: [
      "account_id",
      "telegram_chat_id",
      "username",
      "x_client_id",
      "x_client_secret",
      "credential_owner_account_id",
      "access_token",
      "refresh_token",
      "token_expires_at",
    ],
    media: ["id", "tweet_id", "telegram_file_id", "telegram_file_path", "telegram_file_url", "storage_status"],
    author_topics: ["telegram_chat_id", "author_id", "message_thread_id"],
  };

  const missing: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(required)) {
    const existing = await listColumns(env, table);
    const missingColumns = columns.filter((column) => !existing.has(column));
    if (missingColumns.length > 0) {
      missing[table] = missingColumns;
    }
  }

  return {
    ok: Object.keys(missing).length === 0,
    missing,
  };
}

async function listColumns(env: Env, table: string): Promise<Set<string>> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name).filter(Boolean));
}
