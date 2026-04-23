import { normalizeLanguage, type Language } from "./i18n";
import type { AuthState, Env } from "./types";

const AUTH_PREFIX = "auth_state:";
const POLLING_PREFIX = "polling_lock:";
const LANGUAGE_PREFIX = "user_language:";

export class KVStore {
  constructor(private readonly env: Env) {}

  async setAuthState(state: string, data: AuthState, ttlSeconds = 600): Promise<void> {
    await this.env.KV.put(`${AUTH_PREFIX}${state}`, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    });
  }

  async getAuthState(state: string): Promise<AuthState | null> {
    const value = await this.env.KV.get(`${AUTH_PREFIX}${state}`, "json");
    return value as AuthState | null;
  }

  async deleteAuthState(state: string): Promise<void> {
    await this.env.KV.delete(`${AUTH_PREFIX}${state}`);
  }

  async setPollingLock(accountId: string, ttlSeconds = 120): Promise<void> {
    await this.env.KV.put(`${POLLING_PREFIX}${accountId}`, "1", {
      expirationTtl: ttlSeconds,
    });
  }

  async getPollingLock(accountId: string): Promise<boolean> {
    return (await this.env.KV.get(`${POLLING_PREFIX}${accountId}`)) !== null;
  }

  async deletePollingLock(accountId: string): Promise<void> {
    await this.env.KV.delete(`${POLLING_PREFIX}${accountId}`);
  }

  async acquirePollingLock(accountId: string, ttlSeconds = 120): Promise<boolean> {
    const exists = await this.getPollingLock(accountId);
    if (exists) {
      return false;
    }
    await this.setPollingLock(accountId, ttlSeconds);
    return true;
  }

  async setLanguage(chatId: number, language: Language): Promise<void> {
    await this.env.KV.put(`${LANGUAGE_PREFIX}${chatId}`, language);
  }

  async getLanguage(chatId: number): Promise<Language | null> {
    return normalizeLanguage(await this.env.KV.get(`${LANGUAGE_PREFIX}${chatId}`));
  }
}
