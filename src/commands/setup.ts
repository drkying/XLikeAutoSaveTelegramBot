import type { Bot, Context } from "grammy";
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
): Promise<string> {
  const account = await deps.db.getAccount(accountId);
  if (!account || account.telegram_chat_id !== chatId) {
    throw new Error("Target account was not found.");
  }

  await deps.db.updateAccount(accountId, {
    x_client_id: clientId,
    x_client_secret: clientSecret,
  });
  await clearSetupState(deps.env, chatId);
  return account.username;
}

export function registerSetupCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("setup", async (ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }

    const args = getCommandArgs(ctx.message?.text);
    if (args[0] === "cancel") {
      await clearSetupState(deps.env, chatId);
      await ctx.reply("Setup flow cancelled.");
      return;
    }

    if (args.length >= 3) {
      try {
        const username = await saveAccountCredentials(deps, chatId, args[0], args[1], args[2]);
        await ctx.reply(`API credentials saved for @${username}. Run /login ${args[0]} when this account needs re-authorization.`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Unable to save account credentials.");
      }
      return;
    }

    if (args.length >= 2) {
      await saveCredentials(deps, chatId, args[0], args[1]);
      await ctx.reply("Default X client credentials saved. Run /login to connect a new X account.");
      return;
    }

    if (args.length === 1) {
      const account = await deps.db.getAccount(args[0]);
      if (!account || account.telegram_chat_id !== chatId) {
        await ctx.reply("Usage: /setup [account_id] [client_id client_secret]");
        return;
      }

      await setSetupState(deps.env, chatId, {
        step: "client_id",
        target_account_id: account.account_id,
      });
      await ctx.reply(`Send the X Client ID for @${account.username} in the next message. Use /setup cancel to stop.`);
      return;
    }

    await setSetupState(deps.env, chatId, { step: "client_id" });
    await ctx.reply("Send your default X Client ID in the next message. Use /setup cancel to stop.");
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

  if (state.step === "client_id") {
    await setSetupState(deps.env, chatId, {
      step: "client_secret",
      client_id: text,
      target_account_id: state.target_account_id ?? null,
    });
    await ctx.reply("Client ID saved. Now send the X Client Secret, then delete that chat message afterwards.");
    return true;
  }

  if (!state.client_id) {
    await clearSetupState(deps.env, chatId);
    await ctx.reply("Setup state expired. Please run /setup again.");
    return true;
  }

  if (state.target_account_id) {
    try {
      const username = await saveAccountCredentials(deps, chatId, state.target_account_id, state.client_id, text);
      await ctx.reply(`API credentials saved for @${username}. Run /login ${state.target_account_id} if this account needs fresh authorization.`);
    } catch (error) {
      await clearSetupState(deps.env, chatId);
      await ctx.reply(error instanceof Error ? error.message : "Unable to save account credentials.");
    }
    return true;
  }

  await saveCredentials(deps, chatId, state.client_id, text);
  await ctx.reply("Default X client credentials saved. Run /login to connect an account.");
  return true;
}
