import type { Bot } from "grammy";
import { createAuthLink } from "../auth";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";

export function registerLoginCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("login", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const [accountId] = getCommandArgs(ctx.message?.text);
    if (!accountId) {
      const user = await deps.db.getUser(chatId);
      if (!user) {
        await ctx.reply("You have not saved default X client credentials yet. Run /setup first.");
        return;
      }
    } else {
      const account = await deps.db.getAccount(accountId);
      if (!account || account.telegram_chat_id !== chatId) {
        await ctx.reply("Account not found.");
        return;
      }
    }

    const authLink = await createAuthLink(deps.env, chatId, { accountId });
    await ctx.reply(
      accountId
        ? `Open this link to re-authorize X account ${accountId}:\n${authLink}`
        : `Open this link to connect your X account:\n${authLink}`,
    );
  });
}
