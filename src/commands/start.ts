import type { Bot } from "grammy";
import { buildMainMenuKeyboard, buildStartInlineKeyboard } from "./ui";

export function registerStartCommand(bot: Bot): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "X Like Auto Save Bot",
        "",
        "Type / to use Telegram command autocomplete, or tap the keyboard buttons below for common actions.",
        "",
        "Usage:",
        "/setup - save default X client credentials for a new account",
        "/setup <account_id> - update credentials for one connected account",
        "/login - connect a new X account",
        "/login <account_id> - re-authorize one connected X account",
        "/accounts - list connected accounts",
        "/polling - open the visual polling settings",
        "/convert all - retry x_only media conversion",
        "/status - show current bot status",
      ].join("\n"),
      {
        reply_markup: buildMainMenuKeyboard(),
      },
    );

    await ctx.reply("Quick actions:", {
      reply_markup: buildStartInlineKeyboard(),
    });
  });
}
