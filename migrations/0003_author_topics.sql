CREATE TABLE IF NOT EXISTS author_topics (
    telegram_chat_id   INTEGER NOT NULL,
    author_id          TEXT NOT NULL REFERENCES tweet_authors(author_id),
    topic_name         TEXT NOT NULL,
    message_thread_id  INTEGER NOT NULL,
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (telegram_chat_id, author_id)
);

CREATE INDEX IF NOT EXISTS idx_author_topics_chat_id
  ON author_topics(telegram_chat_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_topics_chat_thread
  ON author_topics(telegram_chat_id, message_thread_id);
