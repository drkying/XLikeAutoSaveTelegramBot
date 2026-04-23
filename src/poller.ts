import { createDatabase } from "./db";
import { t } from "./i18n";
import { KVStore } from "./kv-store";
import { getUserLanguage } from "./language-store";
import { ensureMediaStoredInR2, processMediaItem } from "./media-handler";
import { createCorrelationId, logError, logInfo, logWarn, serializeError } from "./observability";
import { buildTweetFallbackMarkdown, extractMedia, tweetToMarkdown } from "./processor";
import { createForumTopic, notifyAdmin, notifyUser, sendTweetMessage } from "./sender";
import { ensureValidToken, getLikedTweets, XApiError } from "./twitter-api";
import type {
  AccountData,
  Env,
  MediaRecord,
  MediaStorageStatus,
  TweetAuthor,
  TweetRecord,
  UserData,
  XTweet,
} from "./types";

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

function shouldSendViaR2Fallback(media: MediaRecord): boolean {
  return !media.telegram_file_id && Boolean(media.r2_public_url);
}

function shouldSendViaTelegram(media: MediaRecord): boolean {
  if (shouldSendViaR2Fallback(media)) {
    return false;
  }

  return Boolean(media.telegram_file_id ?? media.x_original_url ?? media.r2_public_url);
}

function resolvePersistedMediaStatus(
  media: MediaRecord,
  telegramFileId: string | null | undefined,
): MediaStorageStatus {
  if (telegramFileId) {
    return "telegram";
  }

  if (media.r2_key ?? media.r2_public_url) {
    return "r2";
  }

  if (media.storage_status === "failed") {
    return "failed";
  }

  if (media.x_original_url) {
    return "x_only";
  }

  return "failed";
}

function isGroupChat(chatId: number): boolean {
  return chatId < 0;
}

function buildAuthorTopicName(author: TweetAuthor): string {
  return `@${author.username}`;
}

function isMissingMessageThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("message thread not found");
}

async function resolveAuthorMessageThreadId(
  env: Env,
  db: ReturnType<typeof createDatabase>,
  account: AccountData,
  author: TweetAuthor,
): Promise<number | undefined> {
  if (!isGroupChat(account.telegram_chat_id)) {
    return undefined;
  }

  const existing = await db.getAuthorTopic(account.telegram_chat_id, author.author_id);
  if (existing?.message_thread_id) {
    return existing.message_thread_id;
  }

  const topicName = buildAuthorTopicName(author);
  try {
    const messageThreadId = await createForumTopic(env, account.telegram_chat_id, topicName);
    await db.upsertAuthorTopic({
      telegram_chat_id: account.telegram_chat_id,
      author_id: author.author_id,
      topic_name: topicName,
      message_thread_id: messageThreadId,
    });
    logInfo("poller.telegram_topic.created", {
      account_id: account.account_id,
      chat_id: account.telegram_chat_id,
      author_id: author.author_id,
      username: author.username,
      topic_name: topicName,
      message_thread_id: messageThreadId,
    });
    return messageThreadId;
  } catch (error) {
    logWarn("poller.telegram_topic.create_failed", {
      account_id: account.account_id,
      chat_id: account.telegram_chat_id,
      author_id: author.author_id,
      username: author.username,
      topic_name: topicName,
      ...serializeError(error),
    });
    return undefined;
  }
}

async function sendTweetMessageWithTopicFallback(
  env: Env,
  db: ReturnType<typeof createDatabase>,
  account: AccountData,
  tweet: TweetRecord,
  markdown: string | undefined,
  mediaItems: MediaRecord[],
  messageThreadId?: number,
) {
  try {
    return await sendTweetMessage(
      env,
      account.telegram_chat_id,
      markdown,
      mediaItems,
      { messageThreadId },
    );
  } catch (error) {
    if (!messageThreadId || !isMissingMessageThreadError(error)) {
      throw error;
    }

    await db.deleteAuthorTopic(account.telegram_chat_id, tweet.author_id);
    logWarn("poller.telegram_topic.thread_missing", {
      account_id: account.account_id,
      chat_id: account.telegram_chat_id,
      author_id: tweet.author_id,
      tweet_id: tweet.tweet_id,
      message_thread_id: messageThreadId,
      ...serializeError(error),
    });
    return sendTweetMessage(
      env,
      account.telegram_chat_id,
      markdown,
      mediaItems,
    );
  }
}

async function persistTweetMedia(
  env: Env,
  account: AccountData,
  tweet: TweetRecord,
  mediaItems: MediaRecord[],
  language: Awaited<ReturnType<typeof getUserLanguage>>,
  messageThreadId?: number,
): Promise<void> {
  const db = createDatabase(env);
  const preparedMedia: MediaRecord[] = [];
  for (const media of mediaItems) {
    preparedMedia.push(await processMediaItem(env, media, {
      accountId: account.account_id,
      onlyWhenExceedsTelegramLimit: true,
    }));
  }

  const preparedMediaById = new Map<number, MediaRecord>();
  for (const media of preparedMedia) {
    if (media.id) {
      preparedMediaById.set(media.id, media);
    }
  }

  const fallbackMedia = preparedMedia.filter((media) => shouldSendViaR2Fallback(media));
  const telegramMedia = preparedMedia.filter((media) => shouldSendViaTelegram(media));
  const shouldDeferTweetText = fallbackMedia.length > 0 || telegramMedia.some((media) => !media.telegram_file_id);
  let sentResults: Array<{
    mediaId?: number;
    fileId?: string | null;
    filePath?: string | null;
    fileUrl?: string | null;
  }> = [];
  let sentFallbackMessage = false;
  let sentPlainMessage = false;
  try {
    const allFallbackMedia = [...fallbackMedia];
    if (telegramMedia.length > 0) {
      const sendResult = await sendTweetMessageWithTopicFallback(
        env,
        db,
        account,
        tweet,
        shouldDeferTweetText ? undefined : tweet.text_markdown ?? "",
        telegramMedia,
        messageThreadId,
      );
      sentResults = sendResult.sentResults;

      for (const media of sendResult.fallbackMedia) {
        const uploadedMedia = await ensureMediaStoredInR2(env, media, {
          accountId: account.account_id,
        });
        allFallbackMedia.push(uploadedMedia);
        if (uploadedMedia.id) {
          preparedMediaById.set(uploadedMedia.id, uploadedMedia);
        }
      }
    }

    const sendableFallbackMedia = allFallbackMedia.filter((media) => shouldSendViaR2Fallback(media));
    if (sendableFallbackMedia.length > 0) {
      await sendTweetMessageWithTopicFallback(
        env,
        db,
        account,
        tweet,
        buildTweetFallbackMarkdown(tweet.text_markdown ?? "", sendableFallbackMedia, language),
        [],
        messageThreadId,
      );
      sentFallbackMessage = true;
    } else if (shouldDeferTweetText || telegramMedia.length === 0) {
      await sendTweetMessageWithTopicFallback(
        env,
        db,
        account,
        tweet,
        tweet.text_markdown ?? "",
        [],
        messageThreadId,
      );
      sentPlainMessage = true;
    }

    logInfo("poller.telegram_send.completed", {
      account_id: account.account_id,
      username: account.username,
      tweet_id: tweet.tweet_id,
      media_count: preparedMedia.length,
      telegram_media_count: telegramMedia.length,
      fallback_media_count: sendableFallbackMedia.length,
      deferred_tweet_text: shouldDeferTweetText,
      message_thread_id: messageThreadId ?? null,
      sent_result_count: sentResults.length,
      sent_fallback_message: sentFallbackMessage,
      sent_plain_message: sentPlainMessage,
    });
  } catch (error) {
    logError("poller.telegram_send.failed", {
      account_id: account.account_id,
      username: account.username,
      tweet_id: tweet.tweet_id,
      ...serializeError(error),
    });
    await notifyAdmin(
      env,
      `Telegram send failed for tweet ${tweet.tweet_id} on account @${account.username}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  const sentResultsByMediaId = new Map<number, {
    fileId: string | null;
    filePath?: string | null;
    fileUrl?: string | null;
  }>();
  for (const result of sentResults) {
    if (result.mediaId) {
      sentResultsByMediaId.set(result.mediaId, {
        fileId: result.fileId ?? null,
        filePath: result.filePath ?? null,
        fileUrl: result.fileUrl ?? null,
      });
    }
  }

  const finalPreparedMedia = preparedMedia.map((media) => (
    media.id ? preparedMediaById.get(media.id) ?? media : media
  ));

  for (const media of finalPreparedMedia) {
    if (!media.id) {
      continue;
    }

    const sentResult = sentResultsByMediaId.get(media.id);
    const telegramFileId = sentResult?.fileId ?? media.telegram_file_id ?? undefined;
    await db.updateMediaStatus(media.id, {
      telegram_file_id: telegramFileId,
      telegram_file_path: sentResult?.filePath ?? media.telegram_file_path,
      telegram_file_url: sentResult?.fileUrl ?? media.telegram_file_url,
      r2_key: media.r2_key,
      r2_public_url: media.r2_public_url,
      file_size_bytes: media.file_size_bytes,
      content_type: media.content_type,
      storage_status: resolvePersistedMediaStatus(media, telegramFileId),
    });
  }

  const finalFallbackCount = finalPreparedMedia.filter((media) => shouldSendViaR2Fallback(media)).length;
  if (finalFallbackCount > 0) {
    logWarn("poller.media_fallback_links", {
      account_id: account.account_id,
      username: account.username,
      tweet_id: tweet.tweet_id,
      fallback_count: finalFallbackCount,
    });
  }
}

async function handleTweet(
  env: Env,
  account: AccountData,
  tweet: XTweet,
  includes: Awaited<ReturnType<typeof getLikedTweets>>["includes"],
): Promise<void> {
  const db = createDatabase(env);
  const language = await getUserLanguage(env, account.telegram_chat_id);
  const existing = await db.getTweet(tweet.id);
  if (existing) {
    return;
  }

  const author = await db.upsertAuthor(getTweetAuthor(tweet, includes));
  const markdown = tweetToMarkdown(tweet, includes, language);
  const extractedMedia = extractMedia(tweet, includes);
  const messageThreadId = await resolveAuthorMessageThreadId(env, db, account, author);

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
  logInfo("poller.tweet.persisted", {
    account_id: account.account_id,
    username: account.username,
    tweet_id: tweet.id,
    media_count: extractedMedia.length,
    message_thread_id: messageThreadId ?? null,
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

  await persistTweetMedia(env, account, tweetRecord, mediaRecords, language, messageThreadId);
}

async function getAuthorizedAccount(env: Env, account: AccountData): Promise<{
  account: AccountData;
  user?: UserData;
}> {
  const db = createDatabase(env);
  const user = (!account.x_client_id || !account.x_client_secret)
    ? (await db.getUser(account.telegram_chat_id)) ?? undefined
    : undefined;
  if ((!account.x_client_id || !account.x_client_secret) && !user) {
    throw new Error(`Missing X API credentials for account ${account.account_id}`);
  }

  const authorizedAccount = await ensureValidToken(account, db, user);
  return {
    account: authorizedAccount,
    user,
  };
}

export async function pollAccount(env: Env, account: AccountData): Promise<void> {
  const pollId = createCorrelationId("poll");
  const startedAt = Date.now();
  const db = createDatabase(env);
  const kv = new KVStore(env);
  const acquired = await kv.acquirePollingLock(account.account_id, 120);
  if (!acquired) {
    logWarn("poller.account.locked", {
      poll_id: pollId,
      account_id: account.account_id,
      username: account.username,
    });
    return;
  }

  try {
    logInfo("poller.account.started", {
      poll_id: pollId,
      account_id: account.account_id,
      username: account.username,
    });
    const { account: authorizedAccount, user } = await getAuthorizedAccount(env, account);
    const response = await getLikedTweets(authorizedAccount.account_id, authorizedAccount.access_token, {
      maxResults: 100,
      account: authorizedAccount,
      user,
      db,
    });

    const fetchedTweets = response.data ?? [];
    const existingTweetIds = await db.getExistingTweetIds(fetchedTweets.map((tweet) => tweet.id));
    const tweets = fetchedTweets.filter((tweet) => !existingTweetIds.has(tweet.id)).reverse();
    for (const tweet of tweets) {
      await handleTweet(env, authorizedAccount, tweet, response.includes);
    }

    await db.touchAccountPoll(
      authorizedAccount.account_id,
      response.meta?.newest_id ?? authorizedAccount.last_tweet_id ?? null,
    );
    logInfo("poller.account.completed", {
      poll_id: pollId,
      account_id: authorizedAccount.account_id,
      username: authorizedAccount.username,
      tweet_count: tweets.length,
      newest_id: response.meta?.newest_id ?? null,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    logError("poller.account.failed", {
      poll_id: pollId,
      account_id: account.account_id,
      username: account.username,
      duration_ms: Date.now() - startedAt,
      ...serializeError(error),
    });
    if (error instanceof XApiError && (error.status === 401 || error.status === 403)) {
      const language = await getUserLanguage(env, account.telegram_chat_id);
      await notifyUser(
        env,
        account.telegram_chat_id,
        t(language, "poller_relogin_required", {
          username: account.username,
        }),
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

export async function pollAllAccounts(env: Env, options: { jobId?: string } = {}): Promise<void> {
  const jobId = options.jobId ?? createCorrelationId("pollrun");
  const db = createDatabase(env);
  const accounts = await db.listActiveAccounts();
  let eligibleCount = 0;

  logInfo("poller.run.started", {
    job_id: jobId,
    active_account_count: accounts.length,
  });
  for (const account of accounts) {
    if (!shouldPollAccount(account)) {
      continue;
    }
    eligibleCount += 1;
    await pollAccount(env, account);
  }
  logInfo("poller.run.completed", {
    job_id: jobId,
    active_account_count: accounts.length,
    eligible_account_count: eligibleCount,
  });
}
