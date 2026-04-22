import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { formatAccountSummary, getChatId } from "./helpers";

export function registerAccountsCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("accounts", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const accounts = await deps.db.listAccountsByUser(chatId);
    if (accounts.length === 0) {
      await ctx.reply("No X accounts connected yet. Run /login.");
      return;
    }

    await ctx.reply(["Connected accounts:", ...accounts.map(formatAccountSummary)].join("\n"));
  });
}
