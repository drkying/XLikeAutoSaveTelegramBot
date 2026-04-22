import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import {
  MIN_POLL_INTERVAL_MINUTES,
  getChatId,
  getCommandArgs,
  getOwnedAccount,
  parseHoursRange,
} from "./helpers";
import {
  buildMainMenuKeyboard,
  buildPollingAccountKeyboard,
  buildPollingAccountMessage,
  buildPollingDashboardMessage,
  buildPollingListKeyboard,
} from "./ui";

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
        await ctx.reply("No connected X accounts. Run /login first.", {
          reply_markup: buildMainMenuKeyboard(),
        });
        return;
      }
      await ctx.reply(buildPollingDashboardMessage(accounts), {
        reply_markup: buildPollingListKeyboard(accounts),
      });
      return;
    }

    if (!accountId) {
      await ctx.reply("Usage: /polling <list|on|off|interval|hours> ...\nRun /polling to open the visual settings menu.");
      return;
    }

    const account = await getOwnedAccount(deps, chatId, accountId);
    if (!account) {
      await ctx.reply("Account not found.");
      return;
    }

    if (action === "on" || action === "off") {
      await deps.db.setAccountActive(accountId, action === "on");
      const updated = await deps.db.getAccount(accountId);
      if (!updated) {
        await ctx.reply("Account not found.");
        return;
      }
      await ctx.reply(buildPollingAccountMessage(updated), {
        reply_markup: buildPollingAccountKeyboard(updated),
      });
      return;
    }

    if (action === "interval") {
      const minutes = Number(value);
      if (!Number.isSafeInteger(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES) {
        await ctx.reply(
          `Usage: /polling interval <account_id> <minutes>, minimum ${MIN_POLL_INTERVAL_MINUTES}.`,
        );
        return;
      }
      await deps.db.updateAccount(accountId, { poll_interval_min: minutes });
      const updated = await deps.db.getAccount(accountId);
      if (!updated) {
        await ctx.reply("Account not found.");
        return;
      }
      await ctx.reply(buildPollingAccountMessage(updated), {
        reply_markup: buildPollingAccountKeyboard(updated),
      });
      return;
    }

    if (action === "hours") {
      if (!value) {
        await ctx.reply("Usage: /polling hours <account_id> <start-end>");
        return;
      }
      const hours = parseHoursRange(value);
      if (!hours) {
        await ctx.reply("Invalid hours. Example: /polling hours 12345 8-22");
        return;
      }
      await deps.db.updatePollingSettings(accountId, {
        poll_interval_min: account.poll_interval_min,
        poll_start_hour: hours.start,
        poll_end_hour: hours.end,
      });
      const updated = await deps.db.getAccount(accountId);
      if (!updated) {
        await ctx.reply("Account not found.");
        return;
      }
      await ctx.reply(buildPollingAccountMessage(updated), {
        reply_markup: buildPollingAccountKeyboard(updated),
      });
      return;
    }

    await ctx.reply("Unknown polling action. Use list, on, off, interval, or hours.");
  });
}
