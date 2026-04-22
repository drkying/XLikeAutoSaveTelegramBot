PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    telegram_chat_id  INTEGER PRIMARY KEY,
    x_client_id       TEXT NOT NULL,
    x_client_secret   TEXT NOT NULL,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
);

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
    created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_chat_id ON accounts(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);

CREATE TABLE IF NOT EXISTS tweet_authors (
    author_id         TEXT PRIMARY KEY,
    username          TEXT NOT NULL,
    display_name      TEXT,
    profile_url       TEXT,
    avatar_url        TEXT,
    updated_at        TEXT DEFAULT (datetime('now'))
);

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
);
CREATE INDEX IF NOT EXISTS idx_tweets_account ON tweets(account_id);
CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_id);
CREATE INDEX IF NOT EXISTS idx_tweets_saved ON tweets(saved_at);

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
    created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_tweet ON media(tweet_id);
CREATE INDEX IF NOT EXISTS idx_media_status ON media(storage_status);
