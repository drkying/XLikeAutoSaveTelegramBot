import type {
  AccountData,
  AuthorTopicRecord,
  Env,
  MediaRecord,
  MediaStorageStatus,
  TweetAuthor,
  TweetRecord,
  UserData,
} from "./types";

type SqlValue = string | number | null | undefined;

export interface SearchTweetOptions {
  telegramChatId?: number;
  limit?: number;
}

export class Database {
  constructor(private readonly env: Env) {}

  private prepare(sql: string, ...params: SqlValue[]) {
    return this.env.DB.prepare(sql).bind(...params);
  }

  async getUser(telegramChatId: number): Promise<UserData | null> {
    return (await this.prepare(
      `SELECT * FROM users WHERE telegram_chat_id = ?`,
      telegramChatId,
    ).first<UserData>()) ?? null;
  }

  async createUser(user: UserData): Promise<UserData> {
    await this.prepare(
      `INSERT INTO users (telegram_chat_id, x_client_id, x_client_secret)
       VALUES (?, ?, ?)`,
      user.telegram_chat_id,
      user.x_client_id,
      user.x_client_secret,
    ).run();
    return (await this.getUser(user.telegram_chat_id)) as UserData;
  }

  async updateUser(
    telegramChatId: number,
    patch: Pick<UserData, "x_client_id" | "x_client_secret">,
  ): Promise<UserData | null> {
    await this.prepare(
      `UPDATE users
       SET x_client_id = ?, x_client_secret = ?, updated_at = datetime('now')
       WHERE telegram_chat_id = ?`,
      patch.x_client_id,
      patch.x_client_secret,
      telegramChatId,
    ).run();
    return this.getUser(telegramChatId);
  }

  async upsertUser(user: UserData): Promise<UserData> {
    const existing = await this.getUser(user.telegram_chat_id);
    if (existing) {
      return (await this.updateUser(user.telegram_chat_id, user)) as UserData;
    }
    return this.createUser(user);
  }

  async getAccount(accountId: string): Promise<AccountData | null> {
    return (await this.prepare(
      `SELECT * FROM accounts WHERE account_id = ?`,
      accountId,
    ).first<AccountData>()) ?? null;
  }

  async createAccount(account: AccountData): Promise<AccountData> {
    await this.prepare(
      `INSERT INTO accounts (
         account_id, telegram_chat_id, username, display_name,
         x_client_id, x_client_secret,
         access_token, refresh_token, token_expires_at,
         is_active, poll_interval_min, poll_start_hour, poll_end_hour,
         last_poll_at, last_tweet_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      account.account_id,
      account.telegram_chat_id,
      account.username,
      account.display_name ?? null,
      account.x_client_id ?? null,
      account.x_client_secret ?? null,
      account.access_token,
      account.refresh_token,
      account.token_expires_at,
      account.is_active,
      account.poll_interval_min,
      account.poll_start_hour,
      account.poll_end_hour,
      account.last_poll_at ?? null,
      account.last_tweet_id ?? null,
    ).run();
    return (await this.getAccount(account.account_id)) as AccountData;
  }

  async updateAccount(
    accountId: string,
    patch: Partial<AccountData>,
  ): Promise<AccountData | null> {
    const updates: string[] = [];
    const values: SqlValue[] = [];
    const allowed: Array<keyof AccountData> = [
      "telegram_chat_id",
      "username",
      "display_name",
      "x_client_id",
      "x_client_secret",
      "access_token",
      "refresh_token",
      "token_expires_at",
      "is_active",
      "poll_interval_min",
      "poll_start_hour",
      "poll_end_hour",
      "last_poll_at",
      "last_tweet_id",
    ];

    for (const key of allowed) {
      const value = patch[key];
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value as SqlValue);
      }
    }

    if (updates.length === 0) {
      return this.getAccount(accountId);
    }

    await this.prepare(
      `UPDATE accounts SET ${updates.join(", ")} WHERE account_id = ?`,
      ...values,
      accountId,
    ).run();
    return this.getAccount(accountId);
  }

  async upsertAccount(account: AccountData): Promise<AccountData> {
    const existing = await this.getAccount(account.account_id);
    if (existing) {
      return (await this.updateAccount(account.account_id, account)) as AccountData;
    }
    return this.createAccount(account);
  }

  async deleteAccount(accountId: string, telegramChatId?: number): Promise<void> {
    const ownershipCheck = telegramChatId
      ? await this.prepare(
          `SELECT account_id FROM accounts WHERE account_id = ? AND telegram_chat_id = ?`,
          accountId,
          telegramChatId,
        ).first<{ account_id: string }>()
      : { account_id: accountId };

    if (!ownershipCheck) {
      return;
    }

    await this.prepare(
      `DELETE FROM media WHERE tweet_id IN (SELECT tweet_id FROM tweets WHERE account_id = ?)`,
      accountId,
    ).run();
    await this.prepare(`DELETE FROM tweets WHERE account_id = ?`, accountId).run();
    await this.prepare(`DELETE FROM accounts WHERE account_id = ?`, accountId).run();
  }

  async listAccountsByUser(telegramChatId: number): Promise<AccountData[]> {
    const result = await this.prepare(
      `SELECT * FROM accounts WHERE telegram_chat_id = ? ORDER BY created_at DESC`,
      telegramChatId,
    ).all<AccountData>();
    return result.results ?? [];
  }

  async listActiveAccounts(): Promise<AccountData[]> {
    const result = await this.prepare(
      `SELECT *
       FROM accounts
       WHERE is_active = 1
       ORDER BY CASE WHEN last_poll_at IS NULL THEN 0 ELSE 1 END ASC, last_poll_at ASC, created_at ASC`,
    ).all<AccountData>();
    return result.results ?? [];
  }

  async setAccountActive(accountId: string, isActive: boolean): Promise<AccountData | null> {
    return this.updateAccount(accountId, { is_active: isActive ? 1 : 0 });
  }

  async updatePollingSettings(
    accountId: string,
    patch: Pick<AccountData, "poll_interval_min" | "poll_start_hour" | "poll_end_hour">,
  ): Promise<AccountData | null> {
    return this.updateAccount(accountId, patch);
  }

  async updateAccountTokens(
    accountId: string,
    patch: Pick<AccountData, "access_token" | "refresh_token" | "token_expires_at">,
  ): Promise<AccountData | null> {
    return this.updateAccount(accountId, patch);
  }

  async touchAccountPoll(accountId: string, lastTweetId?: string | null): Promise<AccountData | null> {
    return this.updateAccount(accountId, {
      last_poll_at: new Date().toISOString(),
      last_tweet_id: lastTweetId ?? undefined,
    });
  }

  async upsertAuthor(author: TweetAuthor): Promise<TweetAuthor> {
    await this.prepare(
      `INSERT INTO tweet_authors (author_id, username, display_name, profile_url, avatar_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(author_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         profile_url = excluded.profile_url,
         avatar_url = excluded.avatar_url,
         updated_at = datetime('now')`,
      author.author_id,
      author.username,
      author.display_name ?? null,
      author.profile_url ?? null,
      author.avatar_url ?? null,
    ).run();
    return (await this.getAuthor(author.author_id)) as TweetAuthor;
  }

  async getAuthor(authorId: string): Promise<TweetAuthor | null> {
    return (await this.prepare(
      `SELECT * FROM tweet_authors WHERE author_id = ?`,
      authorId,
    ).first<TweetAuthor>()) ?? null;
  }

  async getAuthorTopic(
    telegramChatId: number,
    authorId: string,
  ): Promise<AuthorTopicRecord | null> {
    return (await this.prepare(
      `SELECT * FROM author_topics WHERE telegram_chat_id = ? AND author_id = ?`,
      telegramChatId,
      authorId,
    ).first<AuthorTopicRecord>()) ?? null;
  }

  async upsertAuthorTopic(topic: AuthorTopicRecord): Promise<AuthorTopicRecord> {
    await this.prepare(
      `INSERT INTO author_topics (telegram_chat_id, author_id, topic_name, message_thread_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_chat_id, author_id) DO UPDATE SET
         topic_name = excluded.topic_name,
         message_thread_id = excluded.message_thread_id,
         updated_at = datetime('now')`,
      topic.telegram_chat_id,
      topic.author_id,
      topic.topic_name,
      topic.message_thread_id,
    ).run();
    return (await this.getAuthorTopic(topic.telegram_chat_id, topic.author_id)) as AuthorTopicRecord;
  }

  async deleteAuthorTopic(telegramChatId: number, authorId: string): Promise<void> {
    await this.prepare(
      `DELETE FROM author_topics WHERE telegram_chat_id = ? AND author_id = ?`,
      telegramChatId,
      authorId,
    ).run();
  }

  async createTweet(tweet: TweetRecord): Promise<TweetRecord> {
    await this.prepare(
      `INSERT INTO tweets (
         tweet_id, account_id, author_id, tweet_url, text_raw, text_markdown,
         liked_at, tweet_created_at, has_media, media_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET
         account_id = excluded.account_id,
         author_id = excluded.author_id,
         tweet_url = excluded.tweet_url,
         text_raw = excluded.text_raw,
         text_markdown = excluded.text_markdown,
         liked_at = excluded.liked_at,
         tweet_created_at = excluded.tweet_created_at,
         has_media = excluded.has_media,
         media_count = excluded.media_count`,
      tweet.tweet_id,
      tweet.account_id,
      tweet.author_id,
      tweet.tweet_url,
      tweet.text_raw ?? null,
      tweet.text_markdown ?? null,
      tweet.liked_at ?? null,
      tweet.tweet_created_at ?? null,
      tweet.has_media,
      tweet.media_count,
    ).run();
    return (await this.getTweet(tweet.tweet_id)) as TweetRecord;
  }

  async getTweet(tweetId: string): Promise<TweetRecord | null> {
    return (await this.prepare(
      `SELECT * FROM tweets WHERE tweet_id = ?`,
      tweetId,
    ).first<TweetRecord>()) ?? null;
  }

  async listTweetsByAccount(accountId: string, limit = 50): Promise<TweetRecord[]> {
    const result = await this.prepare(
      `SELECT * FROM tweets WHERE account_id = ? ORDER BY saved_at DESC LIMIT ?`,
      accountId,
      limit,
    ).all<TweetRecord>();
    return result.results ?? [];
  }

  async listTweetsByAuthor(authorId: string, limit = 50): Promise<TweetRecord[]> {
    const result = await this.prepare(
      `SELECT * FROM tweets WHERE author_id = ? ORDER BY saved_at DESC LIMIT ?`,
      authorId,
      limit,
    ).all<TweetRecord>();
    return result.results ?? [];
  }

  async getExistingTweetIds(tweetIds: readonly string[]): Promise<Set<string>> {
    if (tweetIds.length === 0) {
      return new Set();
    }

    const placeholders = tweetIds.map(() => "?").join(", ");
    const result = await this.prepare(
      `SELECT tweet_id FROM tweets WHERE tweet_id IN (${placeholders})`,
      ...tweetIds,
    ).all<{ tweet_id: string }>();

    return new Set((result.results ?? []).map((row) => row.tweet_id));
  }

  async searchTweets(query: string, options: SearchTweetOptions = {}): Promise<TweetRecord[]> {
    const limit = options.limit ?? 20;
    const term = `%${query}%`;

    if (options.telegramChatId !== undefined) {
      const result = await this.prepare(
        `SELECT t.*
         FROM tweets t
         JOIN accounts a ON a.account_id = t.account_id
         WHERE a.telegram_chat_id = ?
           AND (t.text_raw LIKE ? OR t.text_markdown LIKE ?)
         ORDER BY t.saved_at DESC
         LIMIT ?`,
        options.telegramChatId,
        term,
        term,
        limit,
      ).all<TweetRecord>();
      return result.results ?? [];
    }

    const result = await this.prepare(
      `SELECT * FROM tweets
       WHERE text_raw LIKE ? OR text_markdown LIKE ?
       ORDER BY saved_at DESC
       LIMIT ?`,
      term,
      term,
      limit,
    ).all<TweetRecord>();
    return result.results ?? [];
  }

  async createMedia(media: MediaRecord): Promise<MediaRecord> {
    const existing = media.media_key
      ? await this.prepare(
          `SELECT * FROM media WHERE tweet_id = ? AND media_key = ?`,
          media.tweet_id,
          media.media_key,
        ).first<MediaRecord>()
      : null;

    if (existing?.id) {
      await this.updateMediaStatus(existing.id, media);
      return (await this.getMediaById(existing.id)) as MediaRecord;
    }

    const result = await this.prepare(
      `INSERT INTO media (
         tweet_id, media_key, media_type, telegram_file_id, telegram_file_path, telegram_file_url,
         r2_key, r2_public_url,
         x_original_url, width, height, duration_ms, file_size_bytes,
         content_type, bitrate, storage_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      media.tweet_id,
      media.media_key ?? null,
      media.media_type,
      media.telegram_file_id ?? null,
      media.telegram_file_path ?? null,
      media.telegram_file_url ?? null,
      media.r2_key ?? null,
      media.r2_public_url ?? null,
      media.x_original_url ?? null,
      media.width ?? null,
      media.height ?? null,
      media.duration_ms ?? null,
      media.file_size_bytes ?? null,
      media.content_type ?? null,
      media.bitrate ?? null,
      media.storage_status,
    ).run();

    return (await this.getMediaById(Number(result.meta.last_row_id))) as MediaRecord;
  }

  async updateMediaStatus(id: number, patch: Partial<MediaRecord>): Promise<MediaRecord | null> {
    const updates: string[] = [];
    const values: SqlValue[] = [];
    const allowed: Array<keyof MediaRecord> = [
      "telegram_file_id",
      "telegram_file_path",
      "telegram_file_url",
      "r2_key",
      "r2_public_url",
      "x_original_url",
      "width",
      "height",
      "duration_ms",
      "file_size_bytes",
      "content_type",
      "bitrate",
      "storage_status",
    ];

    for (const key of allowed) {
      const value = patch[key];
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value as SqlValue);
      }
    }

    if (updates.length === 0) {
      return this.getMediaById(id);
    }

    await this.prepare(
      `UPDATE media SET ${updates.join(", ")} WHERE id = ?`,
      ...values,
      id,
    ).run();
    return this.getMediaById(id);
  }

  async getMediaById(id: number): Promise<MediaRecord | null> {
    return (await this.prepare(`SELECT * FROM media WHERE id = ?`, id).first<MediaRecord>()) ?? null;
  }

  async getMediaByTweet(tweetId: string): Promise<MediaRecord[]> {
    const result = await this.prepare(
      `SELECT * FROM media WHERE tweet_id = ? ORDER BY id ASC`,
      tweetId,
    ).all<MediaRecord>();
    return result.results ?? [];
  }

  async listMediaByStatus(
    status: MediaStorageStatus,
    telegramChatId?: number,
    limit = 100,
  ): Promise<MediaRecord[]> {
    if (telegramChatId !== undefined) {
      const result = await this.prepare(
        `SELECT m.*
         FROM media m
         JOIN tweets t ON t.tweet_id = m.tweet_id
         JOIN accounts a ON a.account_id = t.account_id
         WHERE m.storage_status = ? AND a.telegram_chat_id = ?
         ORDER BY m.created_at ASC
         LIMIT ?`,
        status,
        telegramChatId,
        limit,
      ).all<MediaRecord>();
      return result.results ?? [];
    }

    const result = await this.prepare(
      `SELECT * FROM media WHERE storage_status = ? ORDER BY created_at ASC LIMIT ?`,
      status,
      limit,
    ).all<MediaRecord>();
    return result.results ?? [];
  }
}

export function createDatabase(env: Env): Database {
  return new Database(env);
}
