import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { formatAccountSummary, getChatId, getCommandArgs } from "./helpers";

function parseHours(value: string): { start: number; end: number } | null {
  const match = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > 23 || end < 1 || end > 24 || start >= end) {
    return null;
  }

  return { start, end };
}

export function registerPollingCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("polling", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const [action = "list", accountId, value] = getCommandArgs(ctx.message?.text);
    if (action === "list") {
      const accounts = await deps.db.listAccountsByUser(chatId);
      if (accounts.length === 0) {
        await ctx.reply("No connected X accounts. Run /login first.");
        return;
      }
      await ctx.reply(["Polling configuration:", ...accounts.map(formatAccountSummary)].join("\n"));
      return;
    }

    if (!accountId) {
      await ctx.reply("Usage: /polling <list|on|off|interval|hours> ...");
      return;
    }

    const account = await deps.db.getAccount(accountId);
    if (!account || account.telegram_chat_id !== chatId) {
      await ctx.reply("Account not found.");
      return;
    }

    if (action === "on" || action === "off") {
      await deps.db.setAccountActive(accountId, action === "on");
      await ctx.reply(`Polling ${action === "on" ? "enabled" : "disabled"} for @${account.username}.`);
      return;
    }

    if (action === "interval") {
      const minutes = Number(value);
      if (!Number.isSafeInteger(minutes) || minutes < 5) {
        await ctx.reply("Usage: /polling interval <account_id> <minutes>, minimum 5.");
        return;
      }
      await deps.db.updateAccount(accountId, { poll_interval_min: minutes });
      await ctx.reply(`Polling interval updated to ${minutes} minutes for @${account.username}.`);
      return;
    }

    if (action === "hours") {
      if (!value) {
        await ctx.reply("Usage: /polling hours <account_id> <start-end>");
        return;
      }
      const hours = parseHours(value);
      if (!hours) {
        await ctx.reply("Invalid hours. Example: /polling hours 12345 8-22");
        return;
      }
      await deps.db.updatePollingSettings(accountId, {
        poll_interval_min: account.poll_interval_min,
        poll_start_hour: hours.start,
        poll_end_hour: hours.end,
      });
      await ctx.reply(`Polling hours updated to ${hours.start}-${hours.end} UTC for @${account.username}.`);
      return;
    }

    await ctx.reply("Unknown polling action. Use list, on, off, interval, or hours.");
  });
}
