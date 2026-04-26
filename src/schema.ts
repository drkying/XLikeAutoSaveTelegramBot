import { logInfo } from "./observability";
import type { Env } from "./types";

let schemaReadyPromise: Promise<void> | null = null;

const requiredColumns = {
  users: [
    ["credential_owner_account_id", "TEXT"],
  ],
  accounts: [
    ["x_client_id", "TEXT"],
    ["x_client_secret", "TEXT"],
    ["credential_owner_account_id", "TEXT"],
  ],
  media: [
    ["telegram_file_path", "TEXT"],
    ["telegram_file_url", "TEXT"],
  ],
} as const;

export function ensureD1Schema(env: Env): Promise<void> {
  schemaReadyPromise ??= repairD1Schema(env).catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });
  return schemaReadyPromise;
}

async function repairD1Schema(env: Env): Promise<void> {
  await createBaseSchema(env);
  await addMissingColumns(env);
  await backfillAccountCredentials(env);
  await createAuthorTopicsSchema(env);
  logInfo("d1.schema.ready");
}

async function createBaseSchema(env: Env): Promise<void> {
  await execute(env, `
    CREATE TABLE IF NOT EXISTS users (
        telegram_chat_id  INTEGER PRIMARY KEY,
        x_client_id       TEXT NOT NULL,
        x_client_secret   TEXT NOT NULL,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now')),
        credential_owner_account_id TEXT
    )
  `);

  await execute(env, `
    CREATE TABLE IF NOT EXISTS accounts (
        account_id        TEXT PRIMARY KEY,
        telegram_chat_id  INTEGER NOT NULL REFERENCES users(telegram_chat_id),
        username          TEXT NOT NULL,
        display_name      TEXT,
        access_token      TEXT NOT NULL,
        refresh_token     TEXT NOT NULL,
        token_expires_at  INTEGER NOT NULL,
        is_active         INTEGER DEFAULT 1,
        poll_interval_min INTEGER DEFAULT 30,
        poll_start_hour   INTEGER DEFAULT 0,
        poll_end_hour     INTEGER DEFAULT 24,
        last_poll_at      TEXT,
        last_tweet_id     TEXT,
        created_at        TEXT DEFAULT (datetime('now')),
        x_client_id       TEXT,
        x_client_secret   TEXT,
        credential_owner_account_id TEXT
    )
  `);
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_accounts_chat_id ON accounts(telegram_chat_id)");
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active)");

  await execute(env, `
    CREATE TABLE IF NOT EXISTS tweet_authors (
        author_id         TEXT PRIMARY KEY,
        username          TEXT NOT NULL,
        display_name      TEXT,
        profile_url       TEXT,
        avatar_url        TEXT,
        updated_at        TEXT DEFAULT (datetime('now'))
    )
  `);

  await execute(env, `
    CREATE TABLE IF NOT EXISTS tweets (
        tweet_id          TEXT PRIMARY KEY,
        account_id        TEXT NOT NULL REFERENCES accounts(account_id),
        author_id         TEXT NOT NULL REFERENCES tweet_authors(author_id),
        tweet_url         TEXT NOT NULL,
        text_raw          TEXT,
        text_markdown     TEXT,
        liked_at          TEXT,
        tweet_created_at  TEXT,
        saved_at          TEXT DEFAULT (datetime('now')),
        has_media         INTEGER DEFAULT 0,
        media_count       INTEGER DEFAULT 0
    )
  `);
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_tweets_account ON tweets(account_id)");
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_id)");
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_tweets_saved ON tweets(saved_at)");

  await execute(env, `
    CREATE TABLE IF NOT EXISTS media (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id          TEXT NOT NULL REFERENCES tweets(tweet_id),
        media_key         TEXT,
        media_type        TEXT NOT NULL,
        telegram_file_id  TEXT,
        r2_key            TEXT,
        r2_public_url     TEXT,
        x_original_url    TEXT,
        width             INTEGER,
        height            INTEGER,
        duration_ms       INTEGER,
        file_size_bytes   INTEGER,
        content_type      TEXT,
        bitrate           INTEGER,
        storage_status    TEXT DEFAULT 'pending',
        created_at        TEXT DEFAULT (datetime('now')),
        telegram_file_path TEXT,
        telegram_file_url TEXT
    )
  `);
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_media_tweet ON media(tweet_id)");
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_media_status ON media(storage_status)");
}

async function addMissingColumns(env: Env): Promise<void> {
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const existingColumns = await listColumns(env, table);
    for (const [column, type] of columns) {
      if (existingColumns.has(column)) {
        continue;
      }

      await execute(env, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logInfo("d1.schema.column_added", {
        table,
        column,
      });
    }
  }
}

async function backfillAccountCredentials(env: Env): Promise<void> {
  await execute(env, `
    UPDATE accounts
    SET x_client_id = COALESCE(
          x_client_id,
          (SELECT users.x_client_id FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
        ),
        x_client_secret = COALESCE(
          x_client_secret,
          (SELECT users.x_client_secret FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
        )
    WHERE x_client_id IS NULL
       OR x_client_secret IS NULL
  `);
}

async function createAuthorTopicsSchema(env: Env): Promise<void> {
  await execute(env, `
    CREATE TABLE IF NOT EXISTS author_topics (
        telegram_chat_id   INTEGER NOT NULL,
        author_id          TEXT NOT NULL REFERENCES tweet_authors(author_id),
        topic_name         TEXT NOT NULL,
        message_thread_id  INTEGER NOT NULL,
        created_at         TEXT DEFAULT (datetime('now')),
        updated_at         TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (telegram_chat_id, author_id)
    )
  `);
  await execute(env, "CREATE INDEX IF NOT EXISTS idx_author_topics_chat_id ON author_topics(telegram_chat_id)");
  await execute(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_author_topics_chat_thread ON author_topics(telegram_chat_id, message_thread_id)");
}

async function listColumns(env: Env, table: string): Promise<Set<string>> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((result.results ?? []).map((row) => row.name).filter(Boolean));
}

async function execute(env: Env, sql: string): Promise<void> {
  await env.DB.prepare(sql).run();
}
