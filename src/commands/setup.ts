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

    if (args.length >= 2) {
      await saveCredentials(deps, chatId, args[0], args[1]);
      await ctx.reply("X client credentials saved. Run /login to connect an X account.");
      return;
    }

    await setSetupState(deps.env, chatId, { step: "client_id" });
    await ctx.reply("Send your X Client ID in the next message. Use /setup cancel to stop.");
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
    });
    await ctx.reply("Client ID saved. Now send your X Client Secret, then delete that chat message afterwards.");
    return true;
  }

  if (!state.client_id) {
    await clearSetupState(deps.env, chatId);
    await ctx.reply("Setup state expired. Please run /setup again.");
    return true;
  }

  await saveCredentials(deps, chatId, state.client_id, text);
  await ctx.reply("X client credentials saved. Run /login to connect an account.");
  return true;
}
