import type { Bot, Context } from "grammy";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";
import { buildAccountsKeyboard, buildAccountsMessage, buildMainMenuKeyboard } from "./ui";

export async function handleAccountsCommand(ctx: Context, deps: CommandDependencies): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [user, accounts] = await Promise.all([
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
  ]);
  if (accounts.length === 0) {
    await ctx.reply(t(language, "accounts_empty"), {
      reply_markup: buildMainMenuKeyboard(language),
    });
    return;
  }

  await ctx.reply(buildAccountsMessage(accounts, language, user), {
    reply_markup: buildAccountsKeyboard(accounts, language),
  });
}

export function registerAccountsCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("accounts", async (ctx) => {
    await handleAccountsCommand(ctx, deps);
  });
}
