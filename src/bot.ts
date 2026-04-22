import { Bot, webhookCallback } from "grammy";
import { createDatabase } from "./db";
import { notifyAdmin } from "./sender";
import { registerAccountsCommand } from "./commands/accounts";
import { registerConvertCommand } from "./commands/convert";
import { registerLoginCommand } from "./commands/login";
import { registerPollingCommand } from "./commands/polling";
import { registerRemoveCommand } from "./commands/remove";
import { registerSetupCommand, handleSetupConversation } from "./commands/setup";
import { registerStartCommand } from "./commands/start";
import { registerStatusCommand } from "./commands/status";
import type { Env } from "./types";

let botInstance: Bot | null = null;
let botInitPromise: Promise<void> | null = null;

function buildKnownCommandSet(): Set<string> {
  return new Set([
    "/start",
    "/setup",
    "/login",
    "/accounts",
    "/remove",
    "/polling",
    "/convert",
    "/status",
  ]);
}

export function getBot(env: Env): Bot {
  if (botInstance) {
    return botInstance;
  }

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const deps = {
    env,
    db: createDatabase(env),
  };
  const knownCommands = buildKnownCommandSet();

  registerStartCommand(bot);
  registerSetupCommand(bot, deps);
  registerLoginCommand(bot, deps);
  registerAccountsCommand(bot, deps);
  registerRemoveCommand(bot, deps);
  registerPollingCommand(bot, deps);
  registerConvertCommand(bot, deps);
  registerStatusCommand(bot, deps);

  bot.on("message:text", async (ctx) => {
    if (await handleSetupConversation(ctx, deps)) {
      return;
    }

    const text = ctx.message.text.trim();
    if (!text.startsWith("/")) {
      return;
    }

    const command = text.split(/\s+/)[0].split("@")[0];
    if (!knownCommands.has(command)) {
      await ctx.reply("Unknown command. Run /start to see the supported commands.");
    }
  });

  bot.catch(async (error) => {
    await notifyAdmin(
      env,
      `Bot update handling failed: ${error.error instanceof Error ? error.error.message : "unknown error"}`,
    );
  });

  botInstance = bot;
  return bot;
}

export function createWebhookHandler(env: Env) {
  const bot = getBot(env);
  const callback = webhookCallback(bot, "cloudflare-mod");

  return async (request: Request) => {
    if (!botInitPromise) {
      botInitPromise = bot.init().catch((error) => {
        botInitPromise = null;
        throw error;
      });
    }
    await botInitPromise;
    return callback(request);
  };
}
