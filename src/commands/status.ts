import type { Bot, Context } from "grammy";
import { resolveCredentialUsage } from "../credential-ownership";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";
import { buildMainMenuKeyboard, buildStatusKeyboard, formatStatusMessage } from "./ui";

export async function handleStatusCommand(ctx: Context, deps: CommandDependencies): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [user, accounts, xOnlyMedia] = await Promise.all([
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
    deps.db.listMediaByStatus("x_only", chatId, 100),
  ]);
  const usage = accounts.map((account) => resolveCredentialUsage(account, user));

  const message = formatStatusMessage({
    defaultCredentialsSaved: Boolean(user),
    connectedAccounts: accounts.length,
    activeAccounts: accounts.filter((account) => account.is_active === 1).length,
    accountCredentialOverrides: usage.filter((item) => item.source === "account-specific").length,
    lowCostAccounts: usage.filter((item) => item.costLevel === "low").length,
    highCostAccounts: usage.filter((item) => item.costLevel === "high").length,
    unknownCostAccounts: usage.filter((item) => item.costLevel === "unknown").length,
    xOnlyMedia: xOnlyMedia.length,
    workersPaidEnabled: deps.env.WORKERS_PAID_ENABLED ?? "false",
  }, language);

  if (accounts.length === 0) {
    await ctx.reply(message, {
      reply_markup: buildMainMenuKeyboard(language),
    });
    return;
  }

  await ctx.reply(message, {
    reply_markup: buildStatusKeyboard(true, language),
  });
}

export function registerStatusCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("status", async (ctx) => {
    await handleStatusCommand(ctx, deps);
  });
}
