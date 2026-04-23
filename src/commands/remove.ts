import type { Bot, Context } from "grammy";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";

export async function handleRemoveCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [accountId] = getCommandArgs(inputText);
  if (!accountId) {
    await ctx.reply(t(language, "remove_usage"));
    return;
  }

  await deps.db.deleteAccount(accountId, chatId);
  await ctx.reply(t(language, "remove_done", {
    accountId,
  }));
}

export function registerRemoveCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("remove", async (ctx) => {
    await handleRemoveCommand(ctx, deps);
  });
}
