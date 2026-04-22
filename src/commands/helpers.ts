import type { Context } from "grammy";
import { Database } from "../db";
import type { AccountData, Env } from "../types";

export interface CommandDependencies {
  env: Env;
  db: Database;
}

export function getChatId(ctx: Context): number | null {
  return ctx.chat?.id ?? null;
}

export function getCommandArgs(text?: string): string[] {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/).slice(1);
}

export function formatAccountSummary(account: AccountData): string {
  const status = account.is_active ? "on" : "off";
  return [
    `- @${account.username} (${account.account_id})`,
    `  polling: ${status}, every ${account.poll_interval_min} min, ${account.poll_start_hour}-${account.poll_end_hour} UTC`,
  ].join("\n");
}
