import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";

export function registerRemoveCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("remove", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const [accountId] = getCommandArgs(ctx.message?.text);
    if (!accountId) {
      await ctx.reply("Usage: /remove <account_id>");
      return;
    }

    await deps.db.deleteAccount(accountId, chatId);
    await ctx.reply(`Removed account ${accountId} if it existed in your account list.`);
  });
}
