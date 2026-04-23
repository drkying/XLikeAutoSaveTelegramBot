import type { Bot, Context } from "grammy";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";
import { buildMainMenuKeyboard, buildStartInlineKeyboard, syncChatCommands } from "./ui";

export async function handleStartCommand(ctx: Context, deps: CommandDependencies): Promise<void> {
  const chatId = getChatId(ctx);
  const language = await getUserLanguage(deps.env, chatId);
  if (chatId) {
    await syncChatCommands(ctx, chatId, language);
  }
  await ctx.reply(
    [
      t(language, "start_title"),
      "",
      t(language, "start_intro"),
      "",
      t(language, "start_usage"),
      t(language, "start_usage_setup_default"),
      t(language, "start_usage_setup_account"),
      t(language, "start_usage_login_default"),
      t(language, "start_usage_login_account"),
      t(language, "start_usage_accounts"),
      t(language, "start_usage_polling"),
      t(language, "start_usage_convert"),
      t(language, "start_usage_status"),
      t(language, "start_usage_language"),
      t(language, "start_usage_credentials"),
    ].join("\n"),
    {
      reply_markup: buildMainMenuKeyboard(language),
    },
  );

  await ctx.reply(t(language, "quick_actions"), {
    reply_markup: buildStartInlineKeyboard(language),
  });
}

export function registerStartCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("start", async (ctx) => {
    await handleStartCommand(ctx, deps);
  });
}
