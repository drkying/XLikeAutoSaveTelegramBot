import type { Context } from "grammy";
import { Database } from "../db";
import { t, type Language } from "../i18n";
import type { AccountData, Env } from "../types";

export interface CommandDependencies {
  env: Env;
  db: Database;
}

export const MIN_POLL_INTERVAL_MINUTES = 5;

export function getChatId(ctx: Context): number | null {
  return ctx.chat?.id ?? null;
}

export function getCommandArgs(text?: string): string[] {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/).slice(1);
}

export function parseHoursRange(value: string): { start: number; end: number } | null {
  const match = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > 23 || end < 1 || end > 24 || start >= end) {
    return null;
  }

  return { start, end };
}

export async function getOwnedAccount(
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
): Promise<AccountData | null> {
  const account = await deps.db.getAccount(accountId);
  if (!account || account.telegram_chat_id !== chatId) {
    return null;
  }

  return account;
}

export function formatAccountSummary(account: AccountData, language: Language): string {
  const status = account.is_active ? t(language, "common_on") : t(language, "common_off");
  const lastPollAt = account.last_poll_at ?? t(language, "common_never");
  const apiCredentials = account.x_client_id && account.x_client_secret
    ? t(language, "account_credentials_account_specific")
    : t(language, "account_credentials_default_fallback");
  return [
    t(language, "account_summary_line_1", {
      username: account.username,
      accountId: account.account_id,
    }),
    t(language, "account_summary_line_2", {
      status,
      minutes: account.poll_interval_min,
      start: account.poll_start_hour,
      end: account.poll_end_hour,
    }),
    t(language, "account_summary_line_3", {
      credentials: apiCredentials,
    }),
    t(language, "account_summary_line_4", {
      lastPollAt,
    }),
  ].join("\n");
}
