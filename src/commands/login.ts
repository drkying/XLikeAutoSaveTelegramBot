import type { Bot } from "grammy";
import { createAuthLink } from "../auth";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";

export function registerLoginCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("login", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const user = await deps.db.getUser(chatId);
    if (!user) {
      await ctx.reply("You have not saved X client credentials yet. Run /setup first.");
      return;
    }

    const authLink = await createAuthLink(deps.env, chatId);
    await ctx.reply(`Open this link to connect your X account:\n${authLink}`);
  });
}
