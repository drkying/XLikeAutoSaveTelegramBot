import type { Database } from "./db";
import { logInfo, logWarn, serializeError } from "./observability";
import type {
  AccountData,
  UserData,
  XLikedTweetsResponse,
  XTokenResponse,
  XUser,
  XUserMeResponse,
} from "./types";

const X_API_BASE_URL = "https://api.x.com";
const X_AUTH_BASE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_ENDPOINT = `${X_API_BASE_URL}/2/oauth2/token`;
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SCOPES = [
  "tweet.read",
  "users.read",
  "like.read",
  "offline.access",
] as const;
const DEFAULT_TWEET_FIELDS = [
  "attachments",
  "author_id",
  "created_at",
  "entities",
  "text",
] as const;
const DEFAULT_EXPANSIONS = ["attachments.media_keys", "author_id"] as const;
const DEFAULT_MEDIA_FIELDS = [
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "preview_image_url",
  "type",
  "url",
  "variants",
  "width",
] as const;
const DEFAULT_USER_FIELDS = ["name", "profile_image_url", "username"] as const;

interface TokenRequestOptions {
  clientId: string;
  clientSecret?: string;
}

export interface ExchangeCodeForTokenOptions extends TokenRequestOptions {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshAccessTokenOptions extends TokenRequestOptions {
  refreshToken: string;
}

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface GetLikedTweetsOptions {
  maxResults?: number;
  sinceId?: string | null;
  paginationToken?: string;
  tweetFields?: readonly string[];
  expansions?: readonly string[];
  mediaFields?: readonly string[];
  userFields?: readonly string[];
  signal?: AbortSignal;
  account?: AccountData;
  user?: UserData;
  db?: Database;
}

interface FetchJsonOptions {
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
  maxRetries?: number;
  retryOnAuthErrors?: boolean;
  refreshContext?: RefreshContext;
}

interface RefreshContext {
  account: AccountData;
  db: Database;
  user?: UserData;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export async function generatePKCE(): Promise<PKCEPair> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );

  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(challengeBytes),
  };
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  scopes: readonly string[] = DEFAULT_SCOPES,
): string {
  const url = new URL(X_AUTH_BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeCodeForToken(
  options: ExchangeCodeForTokenOptions,
): Promise<XTokenResponse> {
  const form = new URLSearchParams({
    code: options.code,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    client_id: options.clientId,
  });

  return requestToken(form, options, 2);
}

export async function refreshAccessToken(
  options: RefreshAccessTokenOptions,
): Promise<XTokenResponse> {
  const form = new URLSearchParams({
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
    client_id: options.clientId,
  });

  return requestToken(form, options, 2);
}

export async function ensureValidToken(
  account: AccountData,
  db: Database,
  user?: UserData,
): Promise<AccountData> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (account.token_expires_at > nowSeconds + TOKEN_REFRESH_SKEW_SECONDS) {
    return account;
  }

  if (!account.refresh_token) {
    throw new XApiError(
      `Refresh token missing for account ${account.account_id}; user must log in again.`,
      401,
    );
  }

  logInfo("x.token.refresh_required", {
    account_id: account.account_id,
    username: account.username,
    expires_at: account.token_expires_at,
  });
  return refreshAccountAccessToken(account, user, db);
}

export async function getUserMe(
  accessToken: string,
  options: Pick<FetchJsonOptions, "signal"> = {},
): Promise<XUser> {
  const response = await fetchXApiJson<XUserMeResponse>("/2/users/me", accessToken, {
    signal: options.signal,
    query: {
      "user.fields": DEFAULT_USER_FIELDS.join(","),
    },
  });

  return response.data;
}

export async function getLikedTweets(
  userId: string,
  accessToken: string,
  options: GetLikedTweetsOptions = {},
): Promise<XLikedTweetsResponse> {
  const maxResults = clamp(options.maxResults ?? 100, 5, 100);
  const refreshContext = options.account && options.db
    ? {
        account: options.account,
        db: options.db,
        user: options.user,
      }
    : undefined;

  return fetchXApiJson<XLikedTweetsResponse>(
    `/2/users/${encodeURIComponent(userId)}/liked_tweets`,
    accessToken,
    {
      signal: options.signal,
      refreshContext,
      query: {
        max_results: maxResults,
        since_id: options.sinceId ?? undefined,
        pagination_token: options.paginationToken,
        expansions: (options.expansions ?? DEFAULT_EXPANSIONS).join(","),
        "tweet.fields": (options.tweetFields ?? DEFAULT_TWEET_FIELDS).join(","),
        "media.fields": (options.mediaFields ?? DEFAULT_MEDIA_FIELDS).join(","),
        "user.fields": (options.userFields ?? DEFAULT_USER_FIELDS).join(","),
      },
    },
  );
}

async function requestToken(
  form: URLSearchParams,
  options: TokenRequestOptions,
  maxRetries: number,
): Promise<XTokenResponse> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });

  if (options.clientSecret) {
    headers.set("authorization", `Basic ${base64EncodeUtf8(`${options.clientId}:${options.clientSecret}`)}`);
  }

  const response = await fetchWithRetry(
    X_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers,
      body: form.toString(),
    },
    {
      maxRetries,
      retryOnAuthErrors: false,
    },
  );
  const payload = await readJsonResponse<XTokenResponse>(response);

  if (
    !payload ||
    typeof payload.access_token !== "string" ||
    typeof payload.expires_in !== "number" ||
    typeof payload.token_type !== "string"
  ) {
    throw new XApiError("X token endpoint returned an invalid payload.", response.status, payload);
  }

  return payload;
}

async function fetchXApiJson<T>(
  path: string,
  accessToken: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  let currentAccessToken = accessToken;
  const url = buildApiUrl(path, options.query);
  const headers = new Headers({
    authorization: `Bearer ${currentAccessToken}`,
  });

  if (options.refreshContext) {
    const refreshedAccount = await ensureValidToken(
      options.refreshContext.account,
      options.refreshContext.db,
      options.refreshContext.user,
    );
    currentAccessToken = refreshedAccount.access_token;
    headers.set("authorization", `Bearer ${currentAccessToken}`);
  }

  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers,
      signal: options.signal,
    },
    {
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryOnAuthErrors: options.retryOnAuthErrors ?? true,
      refreshContext: options.refreshContext,
      onTokenRefresh(nextToken) {
        currentAccessToken = nextToken;
        headers.set("authorization", `Bearer ${currentAccessToken}`);
      },
    },
  );

  return readJsonResponse<T>(response);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    maxRetries: number;
    retryOnAuthErrors: boolean;
    refreshContext?: RefreshContext;
    onTokenRefresh?: (nextToken: string) => void;
  },
): Promise<Response> {
  let attempt = 0;
  let authRefreshed = false;

  while (true) {
    attempt += 1;

    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }

      if (
        response.status === 401 &&
        options.refreshContext &&
        !authRefreshed
      ) {
        authRefreshed = true;
        const refreshedAccount = await refreshAccountAccessToken(
          options.refreshContext.account,
          options.refreshContext.user,
          options.refreshContext.db,
        );
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${refreshedAccount.access_token}`);
        init = { ...init, headers };
        options.onTokenRefresh?.(refreshedAccount.access_token);
        continue;
      }

      if (
        attempt > options.maxRetries ||
        !shouldRetryStatus(response.status, options.retryOnAuthErrors)
      ) {
        const payload = await readErrorPayload(response);
        logWarn("x.api.request_failed", {
          url,
          method: init.method ?? "GET",
          attempt,
          status: response.status,
          payload,
        });
        throw new XApiError(
          buildErrorMessage(response.status, payload),
          response.status,
          payload,
        );
      }

      logWarn("x.api.retrying", {
        url,
        method: init.method ?? "GET",
        attempt,
        status: response.status,
      });
      await sleep(getRetryDelayMs(response, attempt));
    } catch (error) {
      if (error instanceof XApiError) {
        throw error;
      }

      if (attempt > options.maxRetries) {
        const message = error instanceof Error ? error.message : "Network request to X API failed.";
        logWarn("x.api.network_failed", {
          url,
          method: init.method ?? "GET",
          attempt,
          ...serializeError(error),
        });
        throw new XApiError(message);
      }

      logWarn("x.api.network_retrying", {
        url,
        method: init.method ?? "GET",
        attempt,
        ...serializeError(error),
      });
      await sleep(getNetworkRetryDelayMs(attempt));
    }
  }
}

async function refreshAccountAccessToken(
  account: AccountData,
  user: UserData | undefined,
  db: Database,
): Promise<AccountData> {
  const clientId = account.x_client_id ?? user?.x_client_id;
  const clientSecret = account.x_client_secret ?? user?.x_client_secret;
  if (!clientId || !clientSecret) {
    throw new XApiError(
      `Client credentials missing for account ${account.account_id}; update credentials and log in again.`,
      401,
    );
  }

  const token = await refreshAccessToken({
    refreshToken: account.refresh_token,
    clientId,
    clientSecret,
  });

  const nextAccount: AccountData = {
    ...account,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? account.refresh_token,
    token_expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
  };
  const updated = await db.updateAccountTokens(account.account_id, {
    access_token: nextAccount.access_token,
    refresh_token: nextAccount.refresh_token,
    token_expires_at: nextAccount.token_expires_at,
  });

  Object.assign(account, nextAccount);
  logInfo("x.token.refreshed", {
    account_id: account.account_id,
    username: account.username,
    token_expires_at: nextAccount.token_expires_at,
  });
  return updated ?? nextAccount;
}

function buildApiUrl(
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(path, X_API_BASE_URL);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function shouldRetryStatus(status: number, retryOnAuthErrors: boolean): boolean {
  if (status === 429) {
    return true;
  }

  if (status >= 500 && status <= 599) {
    return true;
  }

  if (retryOnAuthErrors && (status === 401 || status === 403)) {
    return true;
  }

  return false;
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = parseRetryAfterMs(response);
  if (retryAfter !== null) {
    return retryAfter;
  }

  if (response.status === 401) {
    return 250;
  }

  if (response.status === 403) {
    return Math.min(500 * attempt, 2_000);
  }

  return getNetworkRetryDelayMs(attempt);
}

function getNetworkRetryDelayMs(attempt: number): number {
  return Math.min(500 * (2 ** (attempt - 1)), 8_000);
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return clamp(Math.round(seconds * 1_000), 250, 30_000);
    }

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return clamp(dateMs - Date.now(), 250, 30_000);
    }
  }

  const reset = response.headers.get("x-rate-limit-reset");
  if (reset) {
    const resetSeconds = Number(reset);
    if (Number.isFinite(resetSeconds)) {
      return clamp((resetSeconds * 1_000) - Date.now(), 250, 30_000);
    }
  }

  return null;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json();
  return payload as T;
}

async function readErrorPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text || null;
}

function buildErrorMessage(status: number, payload: unknown): string {
  const detail = extractErrorDetail(payload);
  if (detail) {
    return `X API request failed with ${status}: ${detail}`;
  }

  return `X API request failed with ${status}.`;
}

function extractErrorDetail(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const directDetail = payload.detail;
  if (typeof directDetail === "string" && directDetail) {
    return directDetail;
  }

  const directError = payload.error;
  if (typeof directError === "string" && directError) {
    return directError;
  }

  const title = payload.title;
  if (typeof title === "string" && title) {
    return title;
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (!isRecord(item)) {
        continue;
      }

      const detail = item.detail;
      if (typeof detail === "string" && detail) {
        return detail;
      }

      const itemTitle = item.title;
      if (typeof itemTitle === "string" && itemTitle) {
        return itemTitle;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return btoa(bytesToBinary(bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64EncodeUtf8(value: string): string {
  return btoa(bytesToBinary(new TextEncoder().encode(value)));
}

function bytesToBinary(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return binary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
