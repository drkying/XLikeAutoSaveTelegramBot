import type { Context } from "hono";
import {
  findKnownCredentialOwnerAccountIdInChat,
  resolveCredentialUsage,
  syncCredentialOwnerAcrossChatBindings,
} from "./credential-ownership";
import { Database, createDatabase } from "./db";
import { DEFAULT_LANGUAGE, t, type Language } from "./i18n";
import { KVStore } from "./kv-store";
import { getUserLanguage } from "./language-store";
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

function htmlPage(language: Language, title: string, message: string): string {
  return `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : "en"}">
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
  credentialOwnerAccountId?: string | null;
  expectedAccountId?: string | null;
}

async function resolveAuthCredentialContext(
  db: Database,
  telegramChatId: number,
  language: Language,
  targetAccountId?: string,
): Promise<AuthCredentialContext> {
  if (targetAccountId) {
    const [account, user] = await Promise.all([
      db.getAccount(targetAccountId),
      db.getUser(telegramChatId),
    ]);
    if (!account || account.telegram_chat_id !== telegramChatId) {
      throw new Error(t(language, "auth_target_account_not_found"));
    }

    const usage = resolveCredentialUsage(account, user);
    if (!usage.clientId || !usage.clientSecret) {
      throw new Error(t(language, "auth_account_missing_credentials", {
        username: account.username,
        accountId: account.account_id,
      }));
    }

    return {
      clientId: usage.clientId,
      clientSecret: usage.clientSecret,
      credentialOwnerAccountId: usage.ownerAccountId,
      expectedAccountId: account.account_id,
    };
  }

  const user = await db.getUser(telegramChatId);
  if (!user) {
    throw new Error(t(language, "auth_user_not_setup"));
  }

  return {
    clientId: user.x_client_id,
    clientSecret: user.x_client_secret,
    credentialOwnerAccountId: user.credential_owner_account_id ?? null,
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
  const language = await getUserLanguage(env, telegramChatId);
  const authContext = await resolveAuthCredentialContext(db, telegramChatId, language, options.accountId);

  const pkce = await generatePKCE();
  const state = crypto.randomUUID();
  const authState: AuthState = {
    code_verifier: pkce.codeVerifier,
    telegram_chat_id: telegramChatId,
    x_client_id: authContext.clientId,
    x_client_secret: authContext.clientSecret,
    credential_owner_account_id: authContext.credentialOwnerAccountId ?? null,
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
  language: Language,
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
    throw new Error(t(language, "auth_account_mismatch", {
      username: me.username,
    }));
  }
  const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
  const credentialOwnerAccountId = authState.credential_owner_account_id
    ?? (
      await findKnownCredentialOwnerAccountIdInChat(
        db,
        authState.telegram_chat_id,
        authState.x_client_id,
        authState.x_client_secret,
      )
    )
    ?? me.id;

  await db.upsertAccount({
    account_id: me.id,
    telegram_chat_id: authState.telegram_chat_id,
    username: me.username,
    display_name: me.name,
    x_client_id: authState.x_client_id,
    x_client_secret: authState.x_client_secret,
    credential_owner_account_id: credentialOwnerAccountId,
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
  await syncCredentialOwnerAcrossChatBindings(
    db,
    authState.telegram_chat_id,
    authState.x_client_id,
    authState.x_client_secret,
    credentialOwnerAccountId,
  );

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
    return c.text(t(DEFAULT_LANGUAGE, "auth_missing_chat_id"), 400);
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isSafeInteger(chatId)) {
    logInfo("auth.login.invalid_request", {
      request_id: requestId,
      reason: "invalid_chat_id",
      chat_id_raw: chatIdRaw,
    });
    return c.text(t(DEFAULT_LANGUAGE, "auth_invalid_chat_id"), 400);
  }

  const language = await getUserLanguage(c.env, chatId);

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
    const message = error instanceof Error ? error.message : t(language, "auth_unable_create_link");
    return c.html(htmlPage(language, t(language, "auth_login_unavailable_title"), message), 400);
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
    const authStateForError = state ? await kv.getAuthState(state) : null;
    const language = authStateForError
      ? await getUserLanguage(c.env, authStateForError.telegram_chat_id)
      : DEFAULT_LANGUAGE;
    logInfo("auth.callback.denied", {
      request_id: requestId,
      state,
      error_code: errorCode,
      error_description: errorDescription,
    });
    return c.html(
      htmlPage(
        language,
        t(language, "auth_authorization_failed_title"),
        errorDescription ?? errorCode,
      ),
      400,
    );
  }

  if (!state || !code) {
    logInfo("auth.callback.invalid_request", {
      request_id: requestId,
      has_state: Boolean(state),
      has_code: Boolean(code),
    });
    return c.html(
      htmlPage(
        DEFAULT_LANGUAGE,
        t(DEFAULT_LANGUAGE, "auth_invalid_callback_title"),
        t(DEFAULT_LANGUAGE, "auth_missing_state_or_code"),
      ),
      400,
    );
  }

  const authState = await kv.getAuthState(state);
  if (!authState) {
    logInfo("auth.callback.state_missing", {
      request_id: requestId,
      state,
    });
    return c.html(
      htmlPage(
        DEFAULT_LANGUAGE,
        t(DEFAULT_LANGUAGE, "auth_state_expired_title"),
        t(DEFAULT_LANGUAGE, "auth_state_expired_message"),
      ),
      400,
    );
  }

  await kv.deleteAuthState(state);
  const language = await getUserLanguage(c.env, authState.telegram_chat_id);

  try {
    const result = await completeAuthCallback(c.env, db, authState, code, language);
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
      t(language, "auth_connected_notification", {
        username: result.username,
      }),
    );
    return c.html(
      htmlPage(
        language,
        t(language, "auth_login_completed_title"),
        t(language, "auth_connected_page", {
          username: result.username,
        }),
      ),
    );
  } catch (error) {
    logError("auth.callback.failed", {
      request_id: requestId,
      state,
      chat_id: authState.telegram_chat_id,
      ...serializeError(error),
    });
    const message = error instanceof Error ? error.message : t(language, "auth_unexpected_callback_failure");
    await notifyUser(
      c.env,
      authState.telegram_chat_id,
      t(language, "auth_failed_notification", {
        message,
      }),
    );
    return c.html(htmlPage(language, t(language, "auth_login_failed_title"), message), 400);
  }
}
