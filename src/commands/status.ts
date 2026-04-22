import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";
import { buildMainMenuKeyboard, buildStatusKeyboard, formatStatusMessage } from "./ui";

export function registerStatusCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("status", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const user = await deps.db.getUser(chatId);
    const accounts = await deps.db.listAccountsByUser(chatId);
    const xOnlyMedia = await deps.db.listMediaByStatus("x_only", chatId, 100);

    const message = formatStatusMessage({
      defaultCredentialsSaved: Boolean(user),
      connectedAccounts: accounts.length,
      activeAccounts: accounts.filter((account) => account.is_active === 1).length,
      accountCredentialOverrides: accounts.filter((account) => account.x_client_id && account.x_client_secret).length,
      xOnlyMedia: xOnlyMedia.length,
      workersPaidEnabled: deps.env.WORKERS_PAID_ENABLED ?? "false",
    });

    if (accounts.length === 0) {
      await ctx.reply(message, {
        reply_markup: buildMainMenuKeyboard(),
      });
      return;
    }

    await ctx.reply(message, {
      reply_markup: buildStatusKeyboard(true),
    });
  });
}
