import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";
import { buildAccountsKeyboard, buildAccountsMessage, buildMainMenuKeyboard } from "./ui";

export function registerAccountsCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("accounts", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const accounts = await deps.db.listAccountsByUser(chatId);
    if (accounts.length === 0) {
      await ctx.reply("No X accounts connected yet. Run /login.", {
        reply_markup: buildMainMenuKeyboard(),
      });
      return;
    }

    await ctx.reply(buildAccountsMessage(accounts), {
      reply_markup: buildAccountsKeyboard(accounts),
    });
  });
}
