import { KVStore } from "./kv-store";
import { DEFAULT_LANGUAGE, type Language } from "./i18n";
import type { Env } from "./types";

export async function getUserLanguage(env: Env, chatId?: number | null): Promise<Language> {
  if (!chatId) {
    return DEFAULT_LANGUAGE;
  }

  return (await new KVStore(env).getLanguage(chatId)) ?? DEFAULT_LANGUAGE;
}

export async function setUserLanguage(env: Env, chatId: number, language: Language): Promise<void> {
  await new KVStore(env).setLanguage(chatId, language);
}
