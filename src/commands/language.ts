import type { Bot, Context } from "grammy";
import { getLanguageLabel, normalizeLanguage, t } from "../i18n";
import { getUserLanguage, setUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";
import { buildLanguageMenuKeyboard, buildLanguageMenuMessage, buildMainMenuKeyboard } from "./ui";

export async function handleLanguageCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const currentLanguage = await getUserLanguage(deps.env, chatId);
  const [value] = getCommandArgs(inputText);
  if (!value) {
    await ctx.reply(buildLanguageMenuMessage(currentLanguage), {
      reply_markup: buildLanguageMenuKeyboard(currentLanguage),
    });
    return;
  }

  const selectedLanguage = normalizeLanguage(value);
  if (!selectedLanguage) {
    await ctx.reply(
      `${t(currentLanguage, "language_invalid")}\n${t(currentLanguage, "language_usage")}`,
    );
    return;
  }

  await setUserLanguage(deps.env, chatId, selectedLanguage);
  await ctx.reply(
    t(selectedLanguage, "language_updated", {
      language: getLanguageLabel(selectedLanguage, selectedLanguage),
    }),
    {
      reply_markup: buildMainMenuKeyboard(selectedLanguage),
    },
  );
}

export function registerLanguageCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("language", async (ctx) => {
    await handleLanguageCommand(ctx, deps);
  });
}
