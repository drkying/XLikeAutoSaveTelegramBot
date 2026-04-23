export type MediaType = "photo" | "video" | "animated_gif";
export type MediaStorageStatus = "pending" | "telegram" | "r2" | "x_only" | "failed";

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  R2: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_CHAT_ID?: string;
  WEBHOOK_SECRET?: string;
  WORKERS_PAID_ENABLED?: string;
  R2_PUBLIC_DOMAIN?: string;
  APP_BASE_URL: string;
}

export interface UserData {
  telegram_chat_id: number;
  x_client_id: string;
  x_client_secret: string;
  credential_owner_account_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AccountData {
  account_id: string;
  telegram_chat_id: number;
  username: string;
  display_name?: string | null;
  x_client_id?: string | null;
  x_client_secret?: string | null;
  credential_owner_account_id?: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
  is_active: number;
  poll_interval_min: number;
  poll_start_hour: number;
  poll_end_hour: number;
  last_poll_at?: string | null;
  last_tweet_id?: string | null;
  created_at?: string;
}

export interface TweetAuthor {
  author_id: string;
  username: string;
  display_name?: string | null;
  profile_url?: string | null;
  avatar_url?: string | null;
  updated_at?: string;
}

export interface AuthorTopicRecord {
  telegram_chat_id: number;
  author_id: string;
  topic_name: string;
  message_thread_id: number;
  created_at?: string;
  updated_at?: string;
}

export interface TweetRecord {
  tweet_id: string;
  account_id: string;
  author_id: string;
  tweet_url: string;
  text_raw?: string | null;
  text_markdown?: string | null;
  liked_at?: string | null;
  tweet_created_at?: string | null;
  saved_at?: string;
  has_media: number;
  media_count: number;
}

export interface MediaRecord {
  id?: number;
  tweet_id: string;
  media_key?: string | null;
  media_type: MediaType;
  telegram_file_id?: string | null;
  telegram_file_path?: string | null;
  telegram_file_url?: string | null;
  r2_key?: string | null;
  r2_public_url?: string | null;
  x_original_url?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  file_size_bytes?: number | null;
  content_type?: string | null;
  bitrate?: number | null;
  storage_status: MediaStorageStatus;
  created_at?: string;
}

export interface AuthState {
  code_verifier: string;
  telegram_chat_id: number;
  x_client_id: string;
  x_client_secret: string;
  credential_owner_account_id?: string | null;
  expected_account_id?: string | null;
  created_at: string;
}

export interface SetupState {
  step: "client_id" | "client_secret";
  client_id?: string;
  target_account_id?: string | null;
}

export interface XMediaVariant {
  bit_rate?: number;
  content_type: string;
  url: string;
}

export interface XMedia {
  media_key: string;
  type: MediaType;
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  variants?: XMediaVariant[];
  alt_text?: string;
}

export interface XUrlEntity {
  start: number;
  end: number;
  url: string;
  expanded_url?: string;
  display_url?: string;
}

export interface XMentionEntity {
  start: number;
  end: number;
  username: string;
}

export interface XHashtagEntity {
  start: number;
  end: number;
  tag: string;
}

export interface XTweetEntities {
  urls?: XUrlEntity[];
  mentions?: XMentionEntity[];
  hashtags?: XHashtagEntity[];
}

export interface XTweetAttachments {
  media_keys?: string[];
}

export interface XTweet {
  id: string;
  author_id: string;
  text: string;
  created_at?: string;
  entities?: XTweetEntities;
  attachments?: XTweetAttachments;
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

export interface XIncludes {
  media?: XMedia[];
  users?: XUser[];
}

export interface XLikedTweetsResponse {
  data?: XTweet[];
  includes?: XIncludes;
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
    result_count?: number;
  };
  errors?: Array<{
    detail: string;
    status: number;
    title: string;
    type: string;
  }>;
}

export interface XTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope?: string;
  refresh_token?: string;
}

export interface XUserMeResponse {
  data: XUser;
}
