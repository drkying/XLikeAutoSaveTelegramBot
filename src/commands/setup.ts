import type { Bot, Context } from "grammy";
import { t, type Language } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import { getChatId, getCommandArgs } from "./helpers";
import type { SetupState, UserData } from "../types";

const SETUP_STATE_PREFIX = "setup_state:";

async function getSetupState(env: CommandDependencies["env"], chatId: number): Promise<SetupState | null> {
  const state = await env.KV.get(`${SETUP_STATE_PREFIX}${chatId}`, "json");
  return state as SetupState | null;
}

async function setSetupState(
  env: CommandDependencies["env"],
  chatId: number,
  state: SetupState,
): Promise<void> {
  await env.KV.put(`${SETUP_STATE_PREFIX}${chatId}`, JSON.stringify(state), {
    expirationTtl: 900,
  });
}

async function clearSetupState(env: CommandDependencies["env"], chatId: number): Promise<void> {
  await env.KV.delete(`${SETUP_STATE_PREFIX}${chatId}`);
}

async function saveCredentials(
  deps: CommandDependencies,
  chatId: number,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const user: UserData = {
    telegram_chat_id: chatId,
    x_client_id: clientId,
    x_client_secret: clientSecret,
  };
  await deps.db.upsertUser(user);
  await clearSetupState(deps.env, chatId);
}

async function saveAccountCredentials(
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
  clientId: string,
  clientSecret: string,
  language: Language,
): Promise<string> {
  const account = await deps.db.getAccount(accountId);
  if (!account || account.telegram_chat_id !== chatId) {
    throw new Error(t(language, "setup_target_account_not_found"));
  }

  await deps.db.updateAccount(accountId, {
    x_client_id: clientId,
    x_client_secret: clientSecret,
  });
  await clearSetupState(deps.env, chatId);
  return account.username;
}

export async function handleSetupCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const args = getCommandArgs(inputText);
  if (args[0] === "cancel") {
    await clearSetupState(deps.env, chatId);
    await ctx.reply(t(language, "setup_cancelled"));
    return;
  }

  if (args.length >= 3) {
    try {
      const username = await saveAccountCredentials(deps, chatId, args[0], args[1], args[2], language);
      await ctx.reply(t(language, "setup_account_saved", {
        username,
        accountId: args[0],
      }));
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : t(language, "setup_save_failed"));
    }
    return;
  }

  if (args.length >= 2) {
    await saveCredentials(deps, chatId, args[0], args[1]);
    await ctx.reply(t(language, "setup_default_saved"));
    return;
  }

  if (args.length === 1) {
    const account = await deps.db.getAccount(args[0]);
    if (!account || account.telegram_chat_id !== chatId) {
      await ctx.reply(t(language, "setup_usage"));
      return;
    }

    await setSetupState(deps.env, chatId, {
      step: "client_id",
      target_account_id: account.account_id,
    });
    await ctx.reply(t(language, "setup_ask_account_client_id", {
      username: account.username,
    }));
    return;
  }

  await setSetupState(deps.env, chatId, { step: "client_id" });
  await ctx.reply(t(language, "setup_ask_default_client_id"));
}

export function registerSetupCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("setup", async (ctx) => {
    await handleSetupCommand(ctx, deps);
  });
}

export async function handleSetupConversation(
  ctx: Context,
  deps: CommandDependencies,
): Promise<boolean> {
  const chatId = getChatId(ctx);
  const text = ctx.message?.text?.trim();
  if (!chatId || !text || text.startsWith("/")) {
    return false;
  }

  const state = await getSetupState(deps.env, chatId);
  if (!state) {
    return false;
  }

  const language = await getUserLanguage(deps.env, chatId);

  if (state.step === "client_id") {
    await setSetupState(deps.env, chatId, {
      step: "client_secret",
      client_id: text,
      target_account_id: state.target_account_id ?? null,
    });
    await ctx.reply(t(language, "setup_client_id_saved"));
    return true;
  }

  if (!state.client_id) {
    await clearSetupState(deps.env, chatId);
    await ctx.reply(t(language, "setup_state_expired"));
    return true;
  }

  if (state.target_account_id) {
    try {
      const username = await saveAccountCredentials(
        deps,
        chatId,
        state.target_account_id,
        state.client_id,
        text,
        language,
      );
      await ctx.reply(t(language, "setup_account_saved", {
        username,
        accountId: state.target_account_id,
      }));
    } catch (error) {
      await clearSetupState(deps.env, chatId);
      await ctx.reply(error instanceof Error ? error.message : t(language, "setup_save_failed"));
    }
    return true;
  }

  await saveCredentials(deps, chatId, state.client_id, text);
  await ctx.reply(t(language, "setup_default_saved"));
  return true;
}
