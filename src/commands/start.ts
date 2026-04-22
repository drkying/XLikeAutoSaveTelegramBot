import type { Bot } from "grammy";

export function registerStartCommand(bot: Bot): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "X Like Auto Save Bot",
        "",
        "Usage:",
        "/setup - save your X client credentials",
        "/login - connect an X account",
        "/accounts - list connected accounts",
        "/polling list - inspect polling configuration",
        "/convert all - retry x_only media conversion",
        "/status - show current bot status",
      ].join("\n"),
    );
  });
}
