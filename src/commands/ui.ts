import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { pollAccount } from "../poller";
import type { AccountData } from "../types";
import type { CommandDependencies } from "./helpers";
import {
  MIN_POLL_INTERVAL_MINUTES,
  formatAccountSummary,
  getChatId,
  getOwnedAccount,
  parseHoursRange,
} from "./helpers";

const CALLBACK_PREFIX = "ui";
const INTERVAL_PRESETS = [5, 10, 15, 30, 60] as const;
const HOUR_PRESETS = [
  { label: "0-24 UTC", value: "0-24" },
  { label: "6-22 UTC", value: "6-22" },
  { label: "8-20 UTC", value: "8-20" },
  { label: "9-18 UTC", value: "9-18" },
] as const;

export const BOT_COMMANDS = [
  { command: "start", description: "Show the main menu" },
  { command: "setup", description: "Save your X client credentials" },
  { command: "login", description: "Connect an X account" },
  { command: "accounts", description: "List connected X accounts" },
  { command: "remove", description: "Disconnect an X account" },
  { command: "polling", description: "View or change polling settings" },
  { command: "convert", description: "Retry media conversion" },
  { command: "status", description: "Show current bot status" },
] as const;

export async function syncBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS);
}

export function getKnownCommands(): Set<string> {
  return new Set(BOT_COMMANDS.map(({ command }) => `/${command}`));
}

export function buildMainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text("/start")
    .text("/accounts")
    .text("/polling")
    .row()
    .text("/status")
    .text("/login")
    .text("/setup")
    .row()
    .text("/convert all")
    .resized();
}

export function buildStartInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Accounts", `${CALLBACK_PREFIX}:nav:accounts`)
    .text("Polling", `${CALLBACK_PREFIX}:nav:polling`)
    .row()
    .text("Status", `${CALLBACK_PREFIX}:nav:status`)
    .text("Save all now", `${CALLBACK_PREFIX}:save:all`);
}

export function buildAccountsMessage(accounts: AccountData[]): string {
  return [
    "Connected accounts:",
    ...accounts.map(formatAccountSummary),
    "",
    "Use the buttons below to open polling settings or run a manual save.",
  ].join("\n");
}

export function buildAccountsKeyboard(accounts: AccountData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    keyboard
      .text(`Manage @${account.username}`, `${CALLBACK_PREFIX}:poll:view:${account.account_id}`)
      .text(`Save @${account.username}`, `${CALLBACK_PREFIX}:save:account:${account.account_id}`)
      .row();
  }

  return keyboard
    .text("Polling settings", `${CALLBACK_PREFIX}:nav:polling`)
    .text("Save all active", `${CALLBACK_PREFIX}:save:all`);
}

export function buildPollingDashboardMessage(accounts: AccountData[]): string {
  return [
    "Polling settings:",
    ...accounts.map(formatAccountSummary),
    "",
    "Choose an account below to toggle polling, set a preset interval or UTC hour window, or run a manual save.",
    "For custom values, you can still use /polling interval <account_id> <minutes> and /polling hours <account_id> <start-end>.",
  ].join("\n");
}

export function buildPollingListKeyboard(accounts: AccountData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    const status = account.is_active === 1 ? "ON" : "OFF";
    keyboard.text(`${status} @${account.username}`, `${CALLBACK_PREFIX}:poll:view:${account.account_id}`).row();
  }

  return keyboard
    .text("Save all active", `${CALLBACK_PREFIX}:save:all`)
    .text("Status", `${CALLBACK_PREFIX}:nav:status`);
}

export function buildPollingAccountMessage(account: AccountData): string {
  return [
    `Polling settings for @${account.username}:`,
    "",
    formatAccountSummary(account),
    "",
    "Use the buttons below to toggle polling, choose a preset interval or UTC hour window, or run a manual save.",
  ].join("\n");
}

export function buildPollingAccountKeyboard(account: AccountData): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      account.is_active === 1 ? "Turn polling off" : "Turn polling on",
      `${CALLBACK_PREFIX}:poll:toggle:${account.account_id}`,
    )
    .text("Save now", `${CALLBACK_PREFIX}:save:account:${account.account_id}`)
    .row()
    .text("Set interval", `${CALLBACK_PREFIX}:poll:interval-menu:${account.account_id}`)
    .text("Set hours", `${CALLBACK_PREFIX}:poll:hours-menu:${account.account_id}`)
    .row()
    .text("Back to list", `${CALLBACK_PREFIX}:poll:list`)
    .text("Status", `${CALLBACK_PREFIX}:nav:status`);
}

export function buildIntervalMenuMessage(account: AccountData): string {
  return [
    `Choose a polling interval for @${account.username}:`,
    "",
    `Current interval: ${account.poll_interval_min} minutes`,
    "",
    `Need a custom value? Use /polling interval ${account.account_id} <minutes> (minimum ${MIN_POLL_INTERVAL_MINUTES}).`,
  ].join("\n");
}

export function buildIntervalMenuKeyboard(accountId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  INTERVAL_PRESETS.forEach((minutes, index) => {
    keyboard.text(`${minutes} min`, `${CALLBACK_PREFIX}:poll:set-interval:${accountId}:${minutes}`);
    if ((index + 1) % 3 === 0 && index < INTERVAL_PRESETS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard.row().text("Back", `${CALLBACK_PREFIX}:poll:view:${accountId}`);
}

export function buildHoursMenuMessage(account: AccountData): string {
  return [
    `Choose polling hours for @${account.username}:`,
    "",
    `Current hours: ${account.poll_start_hour}-${account.poll_end_hour} UTC`,
    "",
    `Need a custom window? Use /polling hours ${account.account_id} <start-end>.`,
  ].join("\n");
}

export function buildHoursMenuKeyboard(accountId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  HOUR_PRESETS.forEach((preset, index) => {
    keyboard.text(preset.label, `${CALLBACK_PREFIX}:poll:set-hours:${accountId}:${preset.value}`);
    if ((index + 1) % 2 === 0 && index < HOUR_PRESETS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard.row().text("Back", `${CALLBACK_PREFIX}:poll:view:${accountId}`);
}

export function formatStatusMessage(input: {
  defaultCredentialsSaved: boolean;
  connectedAccounts: number;
  activeAccounts: number;
  accountCredentialOverrides: number;
  xOnlyMedia: number;
  workersPaidEnabled: string;
}): string {
  return [
    `default_credentials_saved: ${input.defaultCredentialsSaved ? "yes" : "no"}`,
    `connected_accounts: ${input.connectedAccounts}`,
    `active_accounts: ${input.activeAccounts}`,
    `account_api_credentials: ${input.accountCredentialOverrides}`,
    `x_only_media: ${input.xOnlyMedia}`,
    `workers_paid_enabled: ${input.workersPaidEnabled}`,
  ].join("\n");
}

export function buildStatusKeyboard(hasAccounts: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("Accounts", `${CALLBACK_PREFIX}:nav:accounts`)
    .text("Polling", `${CALLBACK_PREFIX}:nav:polling`);

  if (hasAccounts) {
    keyboard.row().text("Save all active", `${CALLBACK_PREFIX}:save:all`);
  }

  return keyboard;
}

async function updateInlineMessage(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    if (keyboard) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.editMessageText(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("message is not modified")) {
      return;
    }

    if (keyboard) {
      await ctx.reply(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text);
    }
  }
}

async function showAccountsView(ctx: Context, deps: CommandDependencies, chatId: number): Promise<void> {
  const accounts = await deps.db.listAccountsByUser(chatId);
  if (accounts.length === 0) {
    await updateInlineMessage(ctx, "No X accounts connected yet. Run /login first.");
    return;
  }

  await updateInlineMessage(ctx, buildAccountsMessage(accounts), buildAccountsKeyboard(accounts));
}

async function showPollingDashboard(ctx: Context, deps: CommandDependencies, chatId: number): Promise<void> {
  const accounts = await deps.db.listAccountsByUser(chatId);
  if (accounts.length === 0) {
    await updateInlineMessage(ctx, "No connected X accounts. Run /login first.");
    return;
  }

  await updateInlineMessage(ctx, buildPollingDashboardMessage(accounts), buildPollingListKeyboard(accounts));
}

async function showPollingAccountView(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
): Promise<void> {
  const account = await getOwnedAccount(deps, chatId, accountId);
  if (!account) {
    await updateInlineMessage(ctx, "Account not found.");
    return;
  }

  await updateInlineMessage(ctx, buildPollingAccountMessage(account), buildPollingAccountKeyboard(account));
}

async function showStatusView(ctx: Context, deps: CommandDependencies, chatId: number): Promise<void> {
  const [user, accounts, xOnlyMedia] = await Promise.all([
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
    deps.db.listMediaByStatus("x_only", chatId, 100),
  ]);

  await updateInlineMessage(
    ctx,
    formatStatusMessage({
      defaultCredentialsSaved: Boolean(user),
      connectedAccounts: accounts.length,
      activeAccounts: accounts.filter((account) => account.is_active === 1).length,
      accountCredentialOverrides: accounts.filter((account) => account.x_client_id && account.x_client_secret).length,
      xOnlyMedia: xOnlyMedia.length,
      workersPaidEnabled: deps.env.WORKERS_PAID_ENABLED ?? "false",
    }),
    buildStatusKeyboard(accounts.length > 0),
  );
}

async function runManualSaveForAccount(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
): Promise<void> {
  const account = await getOwnedAccount(deps, chatId, accountId);
  if (!account) {
    await ctx.answerCallbackQuery({
      text: "Account not found.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Saving likes for @${account.username}...`,
  });
  await ctx.reply(`Manual save started for @${account.username}. New liked tweets will appear here.`);
  await pollAccount(deps.env, account);

  const updated = await deps.db.getAccount(accountId);
  if (updated) {
    await updateInlineMessage(ctx, buildPollingAccountMessage(updated), buildPollingAccountKeyboard(updated));
  }
  await ctx.reply(`Manual save attempt finished for @${account.username}.`);
}

async function runManualSaveForAll(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
): Promise<void> {
  const accounts = (await deps.db.listAccountsByUser(chatId)).filter((account) => account.is_active === 1);
  if (accounts.length === 0) {
    await ctx.answerCallbackQuery({
      text: "No active accounts available.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Saving ${accounts.length} active account(s)...`,
  });
  await ctx.reply(`Manual save started for ${accounts.length} active account(s).`);
  for (const account of accounts) {
    await pollAccount(deps.env, account);
  }
  await ctx.reply(`Manual save attempt finished for ${accounts.length} active account(s).`);
}

export function registerUiCallbacks(bot: Bot, deps: CommandDependencies): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(`${CALLBACK_PREFIX}:`)) {
      return;
    }

    const chatId = getChatId(ctx);
    if (!chatId) {
      await ctx.answerCallbackQuery({
        text: "Chat not found.",
        show_alert: true,
      });
      return;
    }

    const parts = data.split(":");
    if (parts[1] === "nav") {
      await ctx.answerCallbackQuery();
      if (parts[2] === "accounts") {
        await showAccountsView(ctx, deps, chatId);
        return;
      }
      if (parts[2] === "polling") {
        await showPollingDashboard(ctx, deps, chatId);
        return;
      }
      if (parts[2] === "status") {
        await showStatusView(ctx, deps, chatId);
        return;
      }
    }

    if (parts[1] === "save") {
      if (parts[2] === "all") {
        await runManualSaveForAll(ctx, deps, chatId);
        return;
      }
      if (parts[2] === "account" && parts[3]) {
        await runManualSaveForAccount(ctx, deps, chatId, parts[3]);
        return;
      }
    }

    if (parts[1] === "poll") {
      if (parts[2] === "list") {
        await ctx.answerCallbackQuery();
        await showPollingDashboard(ctx, deps, chatId);
        return;
      }

      const accountId = parts[3];
      if (!accountId) {
        await ctx.answerCallbackQuery({
          text: "Missing account id.",
          show_alert: true,
        });
        return;
      }

      const account = await getOwnedAccount(deps, chatId, accountId);
      if (!account) {
        await ctx.answerCallbackQuery({
          text: "Account not found.",
          show_alert: true,
        });
        return;
      }

      if (parts[2] === "view") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(ctx, buildPollingAccountMessage(account), buildPollingAccountKeyboard(account));
        return;
      }

      if (parts[2] === "toggle") {
        await deps.db.setAccountActive(account.account_id, account.is_active !== 1);
        const updated = await deps.db.getAccount(account.account_id);
        await ctx.answerCallbackQuery({
          text: updated?.is_active === 1 ? "Polling enabled." : "Polling disabled.",
        });
        if (updated) {
          await updateInlineMessage(ctx, buildPollingAccountMessage(updated), buildPollingAccountKeyboard(updated));
        }
        return;
      }

      if (parts[2] === "interval-menu") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(ctx, buildIntervalMenuMessage(account), buildIntervalMenuKeyboard(accountId));
        return;
      }

      if (parts[2] === "set-interval") {
        const minutes = Number(parts[4]);
        if (!Number.isSafeInteger(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES) {
          await ctx.answerCallbackQuery({
            text: "Invalid interval.",
            show_alert: true,
          });
          return;
        }

        await deps.db.updateAccount(accountId, {
          poll_interval_min: minutes,
        });
        const updated = await deps.db.getAccount(accountId);
        await ctx.answerCallbackQuery({
          text: `Interval set to ${minutes} min.`,
        });
        if (updated) {
          await updateInlineMessage(ctx, buildPollingAccountMessage(updated), buildPollingAccountKeyboard(updated));
        }
        return;
      }

      if (parts[2] === "hours-menu") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(ctx, buildHoursMenuMessage(account), buildHoursMenuKeyboard(accountId));
        return;
      }

      if (parts[2] === "set-hours") {
        const value = parts[4];
        const hours = value ? parseHoursRange(value) : null;
        if (!hours) {
          await ctx.answerCallbackQuery({
            text: "Invalid hour range.",
            show_alert: true,
          });
          return;
        }

        await deps.db.updatePollingSettings(accountId, {
          poll_interval_min: account.poll_interval_min,
          poll_start_hour: hours.start,
          poll_end_hour: hours.end,
        });
        const updated = await deps.db.getAccount(accountId);
        await ctx.answerCallbackQuery({
          text: `Hours set to ${hours.start}-${hours.end} UTC.`,
        });
        if (updated) {
          await updateInlineMessage(ctx, buildPollingAccountMessage(updated), buildPollingAccountKeyboard(updated));
        }
        return;
      }
    }

    await ctx.answerCallbackQuery({
      text: "Unsupported action.",
      show_alert: true,
    });
  });
}
