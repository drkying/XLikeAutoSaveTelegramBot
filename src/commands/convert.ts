import type { Bot, Context } from "grammy";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import { processMediaItem } from "../media-handler";
import { sendMediaRecord } from "../sender";
import type { MediaRecord, MediaStorageStatus } from "../types";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";

function normalizeConvertStatus(
  status: MediaStorageStatus | undefined,
): "telegram" | "r2" | "x_only" | "failed" {
  switch (status) {
    case "telegram":
    case "r2":
    case "x_only":
    case "failed":
      return status;
    default:
      return "failed";
  }
}

async function convertMedia(
  deps: CommandDependencies,
  chatId: number,
  media: MediaRecord,
): Promise<"telegram" | "r2" | "x_only" | "failed"> {
  const mediaId = media.id;
  if (!mediaId) {
    return "failed";
  }

  let latest = media;
  try {
    if (!latest.telegram_file_id) {
      const sent = await sendMediaRecord(deps.env, chatId, latest);
      if (sent.fileId) {
        latest = (await deps.db.updateMediaStatus(mediaId, {
          telegram_file_id: sent.fileId,
          telegram_file_path: sent.filePath ?? null,
          telegram_file_url: sent.fileUrl ?? null,
          storage_status: "telegram",
        })) as MediaRecord;
      }
    }
  } catch {
    // Continue to R2 fallback.
  }

  const tweet = await deps.db.getTweet(latest.tweet_id);
  if (!tweet) {
    return "failed";
  }

  const patch = await processMediaItem(deps.env, latest, {
    accountId: tweet.account_id,
    onlyWhenExceedsTelegramLimit: true,
  });
  const saved = await deps.db.updateMediaStatus(mediaId, {
    telegram_file_id: latest.telegram_file_id,
    telegram_file_path: latest.telegram_file_path,
    telegram_file_url: latest.telegram_file_url,
    r2_key: patch.r2_key,
    r2_public_url: patch.r2_public_url,
    file_size_bytes: patch.file_size_bytes,
    content_type: patch.content_type,
    storage_status: latest.telegram_file_id ? "telegram" : patch.storage_status ?? "x_only",
  });
  return normalizeConvertStatus(saved?.storage_status);
}

export async function handleConvertCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [target] = getCommandArgs(inputText);
  if (!target) {
    await ctx.reply(t(language, "convert_usage"));
    return;
  }

  let mediaItems: MediaRecord[] = [];
  if (target === "all") {
    mediaItems = await deps.db.listMediaByStatus("x_only", chatId, 100);
  } else {
    const tweet = await deps.db.getTweet(target);
    if (!tweet) {
      await ctx.reply(t(language, "convert_tweet_not_found"));
      return;
    }

    const account = await deps.db.getAccount(tweet.account_id);
    if (!account || account.telegram_chat_id !== chatId) {
      await ctx.reply(t(language, "convert_tweet_not_owned"));
      return;
    }

    mediaItems = (await deps.db.getMediaByTweet(tweet.tweet_id)).filter(
      (media) => media.storage_status === "x_only",
    );
  }

  if (mediaItems.length === 0) {
    await ctx.reply(t(language, "convert_no_items"));
    return;
  }

  const summary = {
    telegram: 0,
    r2: 0,
    x_only: 0,
    failed: 0,
  };

  for (const media of mediaItems) {
    const result = await convertMedia(deps, chatId, media);
    summary[result] += 1;
  }

  await ctx.reply(t(language, "convert_finished", {
    telegram: summary.telegram,
    r2: summary.r2,
    xOnly: summary.x_only,
    failed: summary.failed,
  }));
}

export function registerConvertCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("convert", async (ctx) => {
    await handleConvertCommand(ctx, deps);
  });
}
