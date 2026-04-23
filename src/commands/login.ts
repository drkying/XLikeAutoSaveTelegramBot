import type { Bot, Context } from "grammy";
import { createAuthLink } from "../auth";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";

export async function handleLoginCommand(
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
    const user = await deps.db.getUser(chatId);
    if (!user) {
      await ctx.reply(t(language, "login_missing_default_credentials"));
      return;
    }
  } else {
    const account = await deps.db.getAccount(accountId);
    if (!account || account.telegram_chat_id !== chatId) {
      await ctx.reply(t(language, "error_account_not_found"));
      return;
    }
  }

  const authLink = await createAuthLink(deps.env, chatId, { accountId });
  await ctx.reply(
    accountId
      ? t(language, "login_reauthorize_link", {
          accountId,
          url: authLink,
        })
      : t(language, "login_connect_link", {
          url: authLink,
        }),
  );
}

export function registerLoginCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("login", async (ctx) => {
    await handleLoginCommand(ctx, deps);
  });
}
