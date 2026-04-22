import type { Bot } from "grammy";
import type { CommandDependencies } from "./helpers";
import { getChatId } from "./helpers";

export function registerStatusCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("status", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const user = await deps.db.getUser(chatId);
    const accounts = await deps.db.listAccountsByUser(chatId);
    const xOnlyMedia = await deps.db.listMediaByStatus("x_only", chatId, 100);

    await ctx.reply(
      [
        `credentials_saved: ${user ? "yes" : "no"}`,
        `connected_accounts: ${accounts.length}`,
        `active_accounts: ${accounts.filter((account) => account.is_active === 1).length}`,
        `x_only_media: ${xOnlyMedia.length}`,
        `workers_paid_enabled: ${deps.env.WORKERS_PAID_ENABLED ?? "false"}`,
      ].join("\n"),
    );
  });
}
