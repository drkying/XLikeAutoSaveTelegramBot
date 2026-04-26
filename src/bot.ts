import { Bot, webhookCallback } from "grammy";
import { createDatabase } from "./db";
import { resolveMenuAction, t } from "./i18n";
import { logError, logInfo, serializeError } from "./observability";
import { notifyAdmin } from "./sender";
import { getTelegramApiBase } from "./telegram-config";
import { registerAccountsCommand } from "./commands/accounts";
import { handleAccountsCommand } from "./commands/accounts";
import { registerCredentialsCommand } from "./commands/credentials";
import { registerConvertCommand } from "./commands/convert";
import { handleConvertCommand } from "./commands/convert";
import { registerLanguageCommand } from "./commands/language";
import { handleLanguageCommand } from "./commands/language";
import { registerLoginCommand } from "./commands/login";
import { handleLoginCommand } from "./commands/login";
import { registerPollingCommand } from "./commands/polling";
import { handlePollingCommand } from "./commands/polling";
import { registerRemoveCommand } from "./commands/remove";
import {
  registerSetupCommand,
  handleSetupConversation,
  interruptSetupConversationIfNeeded,
} from "./commands/setup";
import { handleSetupCommand } from "./commands/setup";
import { registerStartCommand } from "./commands/start";
import { handleStartCommand } from "./commands/start";
import { registerStatusCommand } from "./commands/status";
import { handleStatusCommand } from "./commands/status";
import { getKnownCommands, registerUiCallbacks, syncBotCommands } from "./commands/ui";
import { getUserLanguage } from "./language-store";
import type { Env } from "./types";

let botInstance: Bot | null = null;
let botInitPromise: Promise<void> | null = null;

export function getBot(env: Env): Bot {
  if (botInstance) {
    return botInstance;
  }

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    client: {
      apiRoot: getTelegramApiBase(env),
    },
  });
  const deps = {
    env,
    db: createDatabase(env),
  };
  const knownCommands = getKnownCommands();

  registerStartCommand(bot, deps);
  registerSetupCommand(bot, deps);
  registerLoginCommand(bot, deps);
  registerAccountsCommand(bot, deps);
  registerCredentialsCommand(bot, deps);
  registerRemoveCommand(bot, deps);
  registerPollingCommand(bot, deps);
  registerConvertCommand(bot, deps);
  registerStatusCommand(bot, deps);
  registerLanguageCommand(bot, deps);
  registerUiCallbacks(bot, deps);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat?.id ?? null;
    const menuAction = text.startsWith("/") ? null : resolveMenuAction(text);
    const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0] : null;
    if (
      chatId &&
      (
        (command !== null && command !== "/setup")
        || (menuAction !== null && menuAction !== "setup")
      )
    ) {
      await interruptSetupConversationIfNeeded(deps.env, chatId);
    }

    if (await handleSetupConversation(ctx, deps)) {
      return;
    }

    if (!text.startsWith("/")) {
      const action = resolveMenuAction(text);
      if (action === "start") {
        await handleStartCommand(ctx, deps);
      } else if (action === "accounts") {
        await handleAccountsCommand(ctx, deps);
      } else if (action === "polling") {
        await handlePollingCommand(ctx, deps, "/polling");
      } else if (action === "status") {
        await handleStatusCommand(ctx, deps);
      } else if (action === "login") {
        await handleLoginCommand(ctx, deps, "/login");
      } else if (action === "setup") {
        await handleSetupCommand(ctx, deps, "/setup");
      } else if (action === "convert_all") {
        await handleConvertCommand(ctx, deps, "/convert all");
      } else if (action === "language") {
        await handleLanguageCommand(ctx, deps, "/language");
      }
      return;
    }

    if (command && !knownCommands.has(command)) {
      const language = await getUserLanguage(env, ctx.chat?.id);
      await ctx.reply(t(language, "error_unknown_command"));
    }
  });

  bot.catch(async (error) => {
    logError("bot.update.failed", {
      ...serializeError(error.error),
    });
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
      logInfo("bot.init.started");
      botInitPromise = (async () => {
        try {
          await bot.init();
        } catch (error) {
          botInitPromise = null;
          logError("bot.init.failed", {
            ...serializeError(error),
          });
          throw error;
        }

        try {
          await syncBotCommands(bot);
          logInfo("bot.commands.synced", {
            command_count: getKnownCommands().size,
          });
        } catch (error) {
          logError("bot.commands.sync.failed", {
            ...serializeError(error),
          });
        }
      })();
    }
    await botInitPromise;
    logInfo("bot.webhook.dispatch");
    return callback(request);
  };
}
