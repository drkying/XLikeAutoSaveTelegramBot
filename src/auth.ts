import type { Context } from "hono";
import { Database, createDatabase } from "./db";
import { KVStore } from "./kv-store";
import { logError, logInfo, serializeError } from "./observability";
import { notifyUser } from "./sender";
import type { AuthState, Env } from "./types";
import {
  buildAuthUrl,
  exchangeCodeForToken,
  generatePKCE,
  getUserMe,
} from "./twitter-api";

type AuthHonoContext = Context<{
  Bindings: Env;
  Variables: {
    requestId: string;
    requestStartedAt: number;
  };
}>;

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

interface AuthCredentialContext {
  clientId: string;
  clientSecret: string;
  expectedAccountId?: string | null;
}

async function resolveAuthCredentialContext(
  db: Database,
  telegramChatId: number,
  targetAccountId?: string,
): Promise<AuthCredentialContext> {
  if (targetAccountId) {
    const account = await db.getAccount(targetAccountId);
    if (!account || account.telegram_chat_id !== telegramChatId) {
      throw new Error("Target X account was not found.");
    }

    const fallbackUser = (!account.x_client_id || !account.x_client_secret)
      ? await db.getUser(telegramChatId)
      : null;
    const clientId = account.x_client_id ?? fallbackUser?.x_client_id;
    const clientSecret = account.x_client_secret ?? fallbackUser?.x_client_secret;
    if (!clientId || !clientSecret) {
      throw new Error(`X account @${account.username} has no saved API credentials. Run /setup ${account.account_id}.`);
    }

    return {
      clientId,
      clientSecret,
      expectedAccountId: account.account_id,
    };
  }

  const user = await db.getUser(telegramChatId);
  if (!user) {
    throw new Error("User has not completed /setup yet.");
  }

  return {
    clientId: user.x_client_id,
    clientSecret: user.x_client_secret,
    expectedAccountId: null,
  };
}

export async function createAuthLink(
  env: Env,
  telegramChatId: number,
  options: { accountId?: string } = {},
): Promise<string> {
  const db = createDatabase(env);
  const kv = new KVStore(env);
  const authContext = await resolveAuthCredentialContext(db, telegramChatId, options.accountId);

  const pkce = await generatePKCE();
  const state = crypto.randomUUID();
  const authState: AuthState = {
    code_verifier: pkce.codeVerifier,
    telegram_chat_id: telegramChatId,
    x_client_id: authContext.clientId,
    x_client_secret: authContext.clientSecret,
    expected_account_id: authContext.expectedAccountId ?? null,
    created_at: new Date().toISOString(),
  };

  await kv.setAuthState(state, authState, 600);

  return buildAuthUrl(
    authContext.clientId,
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
  const token = await exchangeCodeForToken({
    code,
    codeVerifier: authState.code_verifier,
    redirectUri: getCallbackUrl(env),
    clientId: authState.x_client_id,
    clientSecret: authState.x_client_secret,
  });

  const me = await getUserMe(token.access_token);
  if (authState.expected_account_id && authState.expected_account_id !== me.id) {
    throw new Error(`Authenticated X account @${me.username} does not match the requested account.`);
  }
  const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;

  await db.upsertAccount({
    account_id: me.id,
    telegram_chat_id: authState.telegram_chat_id,
    username: me.username,
    display_name: me.name,
    x_client_id: authState.x_client_id,
    x_client_secret: authState.x_client_secret,
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

export async function handleAuthLogin(c: AuthHonoContext): Promise<Response> {
  const requestId = c.get("requestId");
  const chatIdRaw = c.req.query("chat_id");
  const accountId = c.req.query("account_id") ?? undefined;
  if (!chatIdRaw) {
    logInfo("auth.login.invalid_request", {
      request_id: requestId,
      reason: "missing_chat_id",
    });
    return c.text("Missing chat_id query parameter.", 400);
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isSafeInteger(chatId)) {
    logInfo("auth.login.invalid_request", {
      request_id: requestId,
      reason: "invalid_chat_id",
      chat_id_raw: chatIdRaw,
    });
    return c.text("Invalid chat_id.", 400);
  }

  try {
    const authUrl = await createAuthLink(c.env, chatId, { accountId });
    logInfo("auth.login.created", {
      request_id: requestId,
      chat_id: chatId,
      account_id: accountId ?? null,
    });
    return c.redirect(authUrl, 302);
  } catch (error) {
    logError("auth.login.failed", {
      request_id: requestId,
      chat_id: chatId,
      account_id: accountId ?? null,
      ...serializeError(error),
    });
    const message = error instanceof Error ? error.message : "Unable to create auth link.";
    return c.html(htmlPage("Login unavailable", message), 400);
  }
}

export async function handleAuthCallback(c: AuthHonoContext): Promise<Response> {
  const requestId = c.get("requestId");
  const state = c.req.query("state");
  const code = c.req.query("code");
  const errorCode = c.req.query("error");
  const errorDescription = c.req.query("error_description");
  const kv = new KVStore(c.env);
  const db = createDatabase(c.env);

  if (errorCode) {
    logInfo("auth.callback.denied", {
      request_id: requestId,
      state,
      error_code: errorCode,
      error_description: errorDescription,
    });
    return c.html(
      htmlPage("Authorization failed", errorDescription ?? errorCode),
      400,
    );
  }

  if (!state || !code) {
    logInfo("auth.callback.invalid_request", {
      request_id: requestId,
      has_state: Boolean(state),
      has_code: Boolean(code),
    });
    return c.html(htmlPage("Invalid callback", "Missing state or code."), 400);
  }

  const authState = await kv.getAuthState(state);
  if (!authState) {
    logInfo("auth.callback.state_missing", {
      request_id: requestId,
      state,
    });
    return c.html(htmlPage("State expired", "Please run /login again."), 400);
  }

  await kv.deleteAuthState(state);

  try {
    const result = await completeAuthCallback(c.env, db, authState, code);
    logInfo("auth.callback.completed", {
      request_id: requestId,
      state,
      chat_id: authState.telegram_chat_id,
      account_id: result.accountId,
      username: result.username,
    });
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
    logError("auth.callback.failed", {
      request_id: requestId,
      state,
      chat_id: authState.telegram_chat_id,
      ...serializeError(error),
    });
    const message = error instanceof Error ? error.message : "Unexpected callback failure.";
    await notifyUser(
      c.env,
      authState.telegram_chat_id,
      `X login failed: ${message}`,
    );
    return c.html(htmlPage("Login failed", message), 400);
  }
}
