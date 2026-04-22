import { createDatabase } from "./db";
import { KVStore } from "./kv-store";
import { processMediaItem } from "./media-handler";
import { extractMedia, tweetToMarkdown } from "./processor";
import { notifyAdmin, notifyUser, sendTweetMessage } from "./sender";
import { ensureValidToken, getLikedTweets, XApiError } from "./twitter-api";
import type { AccountData, Env, MediaRecord, TweetAuthor, TweetRecord, UserData, XTweet } from "./types";

function currentUtcHour(now = new Date()): number {
  return now.getUTCHours();
}

function isWithinPollHours(account: AccountData, now = new Date()): boolean {
  const hour = currentUtcHour(now);
  return hour >= account.poll_start_hour && hour < account.poll_end_hour;
}

function hasReachedPollInterval(account: AccountData, now = new Date()): boolean {
  if (!account.last_poll_at) {
    return true;
  }

  const previous = new Date(account.last_poll_at).getTime();
  if (Number.isNaN(previous)) {
    return true;
  }

  return now.getTime() - previous >= account.poll_interval_min * 60_000;
}

export function shouldPollAccount(account: AccountData, now = new Date()): boolean {
  return account.is_active === 1 && isWithinPollHours(account, now) && hasReachedPollInterval(account, now);
}

function getTweetAuthor(tweet: XTweet, includes: Awaited<ReturnType<typeof getLikedTweets>>["includes"]): TweetAuthor {
  const author = includes?.users?.find((user) => user.id === tweet.author_id);
  const username = author?.username ?? `user-${tweet.author_id}`;
  return {
    author_id: tweet.author_id,
    username,
    display_name: author?.name ?? username,
    profile_url: `https://x.com/${username}`,
    avatar_url: author?.profile_image_url ?? null,
  };
}

async function persistTweetMedia(
  env: Env,
  account: AccountData,
  tweet: TweetRecord,
  mediaItems: MediaRecord[],
): Promise<void> {
  const db = createDatabase(env);

  let sentResults: Array<{ mediaId?: number; fileId?: string | null }> = [];
  try {
    sentResults = await sendTweetMessage(env, account.telegram_chat_id, tweet.text_markdown ?? "", mediaItems);
  } catch (error) {
    await notifyAdmin(
      env,
      `Telegram send failed for tweet ${tweet.tweet_id} on account @${account.username}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  for (const result of sentResults) {
    if (result.mediaId && result.fileId) {
      await db.updateMediaStatus(result.mediaId, {
        telegram_file_id: result.fileId,
        storage_status: "telegram",
      });
    }
  }

  for (const media of mediaItems) {
    const latest = media.id ? await db.getMediaById(media.id) : media;
    if (!latest) {
      continue;
    }

    const r2Patch = await processMediaItem(env, latest, {
      accountId: account.account_id,
    });
    if (latest.telegram_file_id || sentResults.find((item) => item.mediaId === latest.id && item.fileId)) {
      await db.updateMediaStatus(latest.id as number, {
        r2_key: r2Patch.r2_key,
        r2_public_url: r2Patch.r2_public_url,
        file_size_bytes: r2Patch.file_size_bytes,
        content_type: r2Patch.content_type,
        storage_status: "telegram",
      });
      continue;
    }

    await db.updateMediaStatus(latest.id as number, {
      r2_key: r2Patch.r2_key,
      r2_public_url: r2Patch.r2_public_url,
      file_size_bytes: r2Patch.file_size_bytes,
      content_type: r2Patch.content_type,
      storage_status: r2Patch.storage_status,
    });
  }

  const latestMedia = await Promise.all(
    mediaItems
      .filter((media) => Boolean(media.id))
      .map((media) => db.getMediaById(media.id as number)),
  );
  const fallbackLinks = latestMedia
    .filter((media): media is MediaRecord => Boolean(media))
    .filter((media) => !media.telegram_file_id)
    .map((media) => media.r2_public_url ?? media.x_original_url)
    .filter((value): value is string => Boolean(value));

  if (fallbackLinks.length > 0) {
    await notifyUser(
      env,
      account.telegram_chat_id,
      `Media fallback links for tweet ${tweet.tweet_url}\n${fallbackLinks.join("\n")}`,
    );
  }
}

async function handleTweet(
  env: Env,
  account: AccountData,
  tweet: XTweet,
  includes: Awaited<ReturnType<typeof getLikedTweets>>["includes"],
): Promise<void> {
  const db = createDatabase(env);
  const existing = await db.getTweet(tweet.id);
  if (existing) {
    return;
  }

  const author = await db.upsertAuthor(getTweetAuthor(tweet, includes));
  const markdown = tweetToMarkdown(tweet, includes);
  const extractedMedia = extractMedia(tweet, includes);

  const tweetRecord = await db.createTweet({
    tweet_id: tweet.id,
    account_id: account.account_id,
    author_id: author.author_id,
    tweet_url: `https://x.com/${author.username}/status/${tweet.id}`,
    text_raw: tweet.text,
    text_markdown: markdown,
    liked_at: new Date().toISOString(),
    tweet_created_at: tweet.created_at ?? null,
    has_media: extractedMedia.length > 0 ? 1 : 0,
    media_count: extractedMedia.length,
  });

  const mediaRecords: MediaRecord[] = [];
  for (const media of extractedMedia) {
    const created = await db.createMedia({
      tweet_id: tweetRecord.tweet_id,
      media_key: media.media_key,
      media_type: media.media_type,
      x_original_url: media.x_original_url,
      width: media.width ?? null,
      height: media.height ?? null,
      duration_ms: media.duration_ms ?? null,
      content_type: media.content_type ?? null,
      bitrate: media.bitrate ?? null,
      storage_status: "pending",
    });
    mediaRecords.push(created);
  }

  await persistTweetMedia(env, account, tweetRecord, mediaRecords);
}

async function getAuthorizedAccount(env: Env, account: AccountData): Promise<{
  account: AccountData;
  user: UserData;
}> {
  const db = createDatabase(env);
  const user = await db.getUser(account.telegram_chat_id);
  if (!user) {
    throw new Error(`Missing user credentials for chat ${account.telegram_chat_id}`);
  }

  const authorizedAccount = await ensureValidToken(account, user, db);
  return {
    account: authorizedAccount,
    user,
  };
}

export async function pollAccount(env: Env, account: AccountData): Promise<void> {
  const db = createDatabase(env);
  const kv = new KVStore(env);
  const acquired = await kv.acquirePollingLock(account.account_id, 120);
  if (!acquired) {
    return;
  }

  try {
    const { account: authorizedAccount, user } = await getAuthorizedAccount(env, account);
    const response = await getLikedTweets(authorizedAccount.account_id, authorizedAccount.access_token, {
      sinceId: authorizedAccount.last_tweet_id,
      maxResults: 100,
      account: authorizedAccount,
      user,
      db,
    });

    const tweets = [...(response.data ?? [])].reverse();
    for (const tweet of tweets) {
      await handleTweet(env, authorizedAccount, tweet, response.includes);
    }

    await db.touchAccountPoll(
      authorizedAccount.account_id,
      response.meta?.newest_id ?? authorizedAccount.last_tweet_id ?? null,
    );
  } catch (error) {
    if (error instanceof XApiError && (error.status === 401 || error.status === 403)) {
      await notifyUser(
        env,
        account.telegram_chat_id,
        `X account @${account.username} requires re-login. Please run /login again.`,
      );
    }

    await notifyAdmin(
      env,
      `Poll failed for account @${account.username}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  } finally {
    await kv.deletePollingLock(account.account_id);
  }
}

export async function pollAllAccounts(env: Env): Promise<void> {
  const db = createDatabase(env);
  const accounts = await db.listActiveAccounts();

  for (const account of accounts) {
    if (!shouldPollAccount(account)) {
      continue;
    }
    await pollAccount(env, account);
  }
}
