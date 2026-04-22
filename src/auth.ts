import type { Context } from "hono";
import { Database, createDatabase } from "./db";
import { KVStore } from "./kv-store";
import { notifyUser } from "./sender";
import type { AuthState, Env } from "./types";
import {
  buildAuthUrl,
  exchangeCodeForToken,
  generatePKCE,
  getUserMe,
} from "./twitter-api";

type HonoContext = Context<{ Bindings: Env }>;

function getCallbackUrl(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/auth/callback`;
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem; color: #111827; }
      main { max-width: 40rem; margin: 0 auto; }
      h1 { font-size: 1.5rem; margin-bottom: 0.75rem; }
      p { line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

export async function createAuthLink(env: Env, telegramChatId: number): Promise<string> {
  const db = createDatabase(env);
  const kv = new KVStore(env);
  const user = await db.getUser(telegramChatId);

  if (!user) {
    throw new Error("User has not completed /setup yet.");
  }

  const pkce = await generatePKCE();
  const state = crypto.randomUUID();
  const authState: AuthState = {
    code_verifier: pkce.codeVerifier,
    telegram_chat_id: telegramChatId,
    created_at: new Date().toISOString(),
  };

  await kv.setAuthState(state, authState, 600);

  return buildAuthUrl(
    user.x_client_id,
    getCallbackUrl(env),
    state,
    pkce.codeChallenge,
  );
}

async function completeAuthCallback(
  env: Env,
  db: Database,
  authState: AuthState,
  code: string,
): Promise<{ username: string; accountId: string }> {
  const user = await db.getUser(authState.telegram_chat_id);
  if (!user) {
    throw new Error("User credentials no longer exist.");
  }

  const token = await exchangeCodeForToken({
    code,
    codeVerifier: authState.code_verifier,
    redirectUri: getCallbackUrl(env),
    clientId: user.x_client_id,
    clientSecret: user.x_client_secret,
  });

  const me = await getUserMe(token.access_token);
  const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;

  await db.upsertAccount({
    account_id: me.id,
    telegram_chat_id: authState.telegram_chat_id,
    username: me.username,
    display_name: me.name,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    token_expires_at: expiresAt,
    is_active: 1,
    poll_interval_min: 30,
    poll_start_hour: 0,
    poll_end_hour: 24,
    last_poll_at: null,
    last_tweet_id: null,
  });

  return {
    username: me.username,
    accountId: me.id,
  };
}

export async function handleAuthLogin(c: HonoContext): Promise<Response> {
  const chatIdRaw = c.req.query("chat_id");
  if (!chatIdRaw) {
    return c.text("Missing chat_id query parameter.", 400);
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isSafeInteger(chatId)) {
    return c.text("Invalid chat_id.", 400);
  }

  try {
    const authUrl = await createAuthLink(c.env, chatId);
    return c.redirect(authUrl, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create auth link.";
    return c.html(htmlPage("Login unavailable", message), 400);
  }
}

export async function handleAuthCallback(c: HonoContext): Promise<Response> {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const errorCode = c.req.query("error");
  const errorDescription = c.req.query("error_description");
  const kv = new KVStore(c.env);
  const db = createDatabase(c.env);

  if (errorCode) {
    return c.html(
      htmlPage("Authorization failed", errorDescription ?? errorCode),
      400,
    );
  }

  if (!state || !code) {
    return c.html(htmlPage("Invalid callback", "Missing state or code."), 400);
  }

  const authState = await kv.getAuthState(state);
  if (!authState) {
    return c.html(htmlPage("State expired", "Please run /login again."), 400);
  }

  await kv.deleteAuthState(state);

  try {
    const result = await completeAuthCallback(c.env, db, authState, code);
    await notifyUser(
      c.env,
      authState.telegram_chat_id,
      `X account @${result.username} connected successfully. Polling is enabled by default.`,
    );
    return c.html(
      htmlPage(
        "Login completed",
        `Your X account @${result.username} has been connected. You can return to Telegram now.`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected callback failure.";
    await notifyUser(
      c.env,
      authState.telegram_chat_id,
      `X login failed: ${message}`,
    );
    return c.html(htmlPage("Login failed", message), 400);
  }
}
