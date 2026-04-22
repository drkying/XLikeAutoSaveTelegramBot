import type { Bot } from "grammy";
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
  });
  const saved = await deps.db.updateMediaStatus(mediaId, {
    r2_key: patch.r2_key,
    r2_public_url: patch.r2_public_url,
    file_size_bytes: patch.file_size_bytes,
    content_type: patch.content_type,
    storage_status: latest.telegram_file_id ? "telegram" : patch.storage_status ?? "x_only",
  });
  return normalizeConvertStatus(saved?.storage_status);
}

export function registerConvertCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("convert", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const [target] = getCommandArgs(ctx.message?.text);
    if (!target) {
      await ctx.reply("Usage: /convert <tweet_id|all>");
      return;
    }

    let mediaItems: MediaRecord[] = [];
    if (target === "all") {
      mediaItems = await deps.db.listMediaByStatus("x_only", chatId, 100);
    } else {
      const tweet = await deps.db.getTweet(target);
      if (!tweet) {
        await ctx.reply("Tweet not found.");
        return;
      }

      const account = await deps.db.getAccount(tweet.account_id);
      if (!account || account.telegram_chat_id !== chatId) {
        await ctx.reply("Tweet does not belong to one of your accounts.");
        return;
      }

      mediaItems = (await deps.db.getMediaByTweet(tweet.tweet_id)).filter(
        (media) => media.storage_status === "x_only",
      );
    }

    if (mediaItems.length === 0) {
      await ctx.reply("No x_only media items matched your request.");
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

    await ctx.reply(
      `Convert finished.\ntelegram: ${summary.telegram}\nr2: ${summary.r2}\nx_only: ${summary.x_only}\nfailed: ${summary.failed}`,
    );
  });
}
