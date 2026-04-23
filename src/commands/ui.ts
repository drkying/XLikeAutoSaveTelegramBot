import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { resolveCredentialUsage } from "../credential-ownership";
import { DEFAULT_LANGUAGE, getLanguageLabel, getMenuActionLabel, normalizeLanguage, t, type Language } from "../i18n";
import { getUserLanguage, setUserLanguage } from "../language-store";
import { pollAccount } from "../poller";
import type { AccountData, UserData } from "../types";
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

const BOT_COMMAND_NAMES = [
  "start",
  "setup",
  "login",
  "accounts",
  "remove",
  "polling",
  "convert",
  "status",
  "language",
  "credentials",
] as const;

function getBotCommands(language: Language) {
  return [
    { command: "start", description: t(language, "command_desc_start") },
    { command: "setup", description: t(language, "command_desc_setup") },
    { command: "login", description: t(language, "command_desc_login") },
    { command: "accounts", description: t(language, "command_desc_accounts") },
    { command: "remove", description: t(language, "command_desc_remove") },
    { command: "polling", description: t(language, "command_desc_polling") },
    { command: "convert", description: t(language, "command_desc_convert") },
    { command: "status", description: t(language, "command_desc_status") },
    { command: "language", description: t(language, "command_desc_language") },
    { command: "credentials", description: t(language, "command_desc_credentials") },
  ];
}

export async function syncBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(getBotCommands("en"));
  await bot.api.setMyCommands(getBotCommands("zh"), {
    language_code: "zh",
  });
}

export async function syncChatCommands(
  bot: Bot | Context,
  chatId: number,
  language: Language,
): Promise<void> {
  await bot.api.setMyCommands(getBotCommands(language), {
    scope: {
      type: "chat",
      chat_id: chatId,
    },
  });
}

export function getKnownCommands(): Set<string> {
  return new Set(BOT_COMMAND_NAMES.map((command) => `/${command}`));
}

function formatIntervalPresetLabel(minutes: number, language: Language): string {
  return language === "zh" ? `${minutes} 分` : `${minutes} min`;
}

export function buildMainMenuKeyboard(language: Language): Keyboard {
  return new Keyboard()
    .text(getMenuActionLabel("start", language))
    .text(getMenuActionLabel("accounts", language))
    .text(getMenuActionLabel("polling", language))
    .row()
    .text(getMenuActionLabel("status", language))
    .text(getMenuActionLabel("login", language))
    .text(getMenuActionLabel("setup", language))
    .row()
    .text(getMenuActionLabel("convert_all", language))
    .text(getMenuActionLabel("language", language))
    .resized();
}

export function buildStartInlineKeyboard(language: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(getMenuActionLabel("accounts", language), `${CALLBACK_PREFIX}:nav:accounts`)
    .text(getMenuActionLabel("polling", language), `${CALLBACK_PREFIX}:nav:polling`)
    .row()
    .text(getMenuActionLabel("status", language), `${CALLBACK_PREFIX}:nav:status`)
    .text(t(language, "accounts_save_all_active_button"), `${CALLBACK_PREFIX}:save:all`)
    .row()
    .text(getMenuActionLabel("language", language), `${CALLBACK_PREFIX}:nav:language`);
}

export function buildAccountsMessage(
  accounts: AccountData[],
  language: Language,
  user?: UserData | null,
): string {
  return [
    t(language, "accounts_title"),
    ...accounts.map((account) => formatAccountSummary(account, language, user)),
    "",
    t(language, "accounts_hint"),
  ].join("\n");
}

export function buildAccountsKeyboard(accounts: AccountData[], language: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    keyboard
      .text(
        t(language, "accounts_manage_button", {
          username: account.username,
        }),
        `${CALLBACK_PREFIX}:poll:view:${account.account_id}`,
      )
      .text(
        t(language, "accounts_save_button", {
          username: account.username,
        }),
        `${CALLBACK_PREFIX}:save:account:${account.account_id}`,
      )
      .row();
  }

  return keyboard
    .text(t(language, "accounts_polling_settings_button"), `${CALLBACK_PREFIX}:nav:polling`)
    .text(getMenuActionLabel("language", language), `${CALLBACK_PREFIX}:nav:language`)
    .row()
    .text(t(language, "accounts_save_all_active_button"), `${CALLBACK_PREFIX}:save:all`);
}

export function buildPollingDashboardMessage(
  accounts: AccountData[],
  language: Language,
  user?: UserData | null,
): string {
  return [
    t(language, "polling_title"),
    ...accounts.map((account) => formatAccountSummary(account, language, user)),
    "",
    t(language, "polling_hint"),
    t(language, "polling_custom_hint"),
  ].join("\n");
}

export function buildPollingListKeyboard(accounts: AccountData[], language: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    const status = account.is_active === 1 ? t(language, "common_on_upper") : t(language, "common_off_upper");
    keyboard.text(`${status} @${account.username}`, `${CALLBACK_PREFIX}:poll:view:${account.account_id}`).row();
  }

  return keyboard
    .text(t(language, "accounts_save_all_active_button"), `${CALLBACK_PREFIX}:save:all`)
    .text(getMenuActionLabel("status", language), `${CALLBACK_PREFIX}:nav:status`)
    .row()
    .text(getMenuActionLabel("language", language), `${CALLBACK_PREFIX}:nav:language`);
}

export function buildPollingAccountMessage(
  account: AccountData,
  language: Language,
  user?: UserData | null,
): string {
  return [
    t(language, "polling_account_title", {
      username: account.username,
    }),
    "",
    formatAccountSummary(account, language, user),
    "",
    t(language, "polling_account_hint"),
  ].join("\n");
}

export function buildPollingAccountKeyboard(account: AccountData, language: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      account.is_active === 1 ? t(language, "polling_toggle_off_button") : t(language, "polling_toggle_on_button"),
      `${CALLBACK_PREFIX}:poll:toggle:${account.account_id}`,
    )
    .text(t(language, "polling_save_now_button"), `${CALLBACK_PREFIX}:save:account:${account.account_id}`)
    .row()
    .text(t(language, "polling_set_interval_button"), `${CALLBACK_PREFIX}:poll:interval-menu:${account.account_id}`)
    .text(t(language, "polling_set_hours_button"), `${CALLBACK_PREFIX}:poll:hours-menu:${account.account_id}`)
    .row()
    .text(t(language, "polling_back_to_list_button"), `${CALLBACK_PREFIX}:poll:list`)
    .text(getMenuActionLabel("status", language), `${CALLBACK_PREFIX}:nav:status`)
    .row()
    .text(getMenuActionLabel("language", language), `${CALLBACK_PREFIX}:nav:language`);
}

export function buildIntervalMenuMessage(account: AccountData, language: Language): string {
  return [
    t(language, "polling_interval_menu_title", {
      username: account.username,
    }),
    "",
    t(language, "polling_current_interval", {
      minutes: account.poll_interval_min,
    }),
    "",
    t(language, "polling_interval_custom_hint", {
      accountId: account.account_id,
      minimum: MIN_POLL_INTERVAL_MINUTES,
    }),
  ].join("\n");
}

export function buildIntervalMenuKeyboard(accountId: string, language: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  INTERVAL_PRESETS.forEach((minutes, index) => {
    keyboard.text(formatIntervalPresetLabel(minutes, language), `${CALLBACK_PREFIX}:poll:set-interval:${accountId}:${minutes}`);
    if ((index + 1) % 3 === 0 && index < INTERVAL_PRESETS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard
    .row()
    .text(t(language, "polling_back_button"), `${CALLBACK_PREFIX}:poll:view:${accountId}`);
}

export function buildHoursMenuMessage(account: AccountData, language: Language): string {
  return [
    t(language, "polling_hours_menu_title", {
      username: account.username,
    }),
    "",
    t(language, "polling_current_hours", {
      start: account.poll_start_hour,
      end: account.poll_end_hour,
    }),
    "",
    t(language, "polling_hours_custom_hint", {
      accountId: account.account_id,
    }),
  ].join("\n");
}

export function buildHoursMenuKeyboard(accountId: string, language: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  HOUR_PRESETS.forEach((preset, index) => {
    keyboard.text(preset.label, `${CALLBACK_PREFIX}:poll:set-hours:${accountId}:${preset.value}`);
    if ((index + 1) % 2 === 0 && index < HOUR_PRESETS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard
    .row()
    .text(t(language, "polling_back_button"), `${CALLBACK_PREFIX}:poll:view:${accountId}`);
}

export function buildLanguageMenuMessage(language: Language): string {
  return [
    t(language, "language_title"),
    "",
    t(language, "language_current", {
      language: getLanguageLabel(language, language),
    }),
    t(language, "language_default"),
    t(language, "language_prompt"),
  ].join("\n");
}

export function buildLanguageMenuKeyboard(language: Language): InlineKeyboard {
  const englishLabel = `${language === "en" ? "✓ " : ""}${getLanguageLabel("en", language)}`;
  const chineseLabel = `${language === "zh" ? "✓ " : ""}${getLanguageLabel("zh", language)}`;
  return new InlineKeyboard()
    .text(englishLabel, `${CALLBACK_PREFIX}:lang:set:en`)
    .text(chineseLabel, `${CALLBACK_PREFIX}:lang:set:zh`);
}

export function formatStatusMessage(
  input: {
    defaultCredentialsSaved: boolean;
    connectedAccounts: number;
    activeAccounts: number;
    accountCredentialOverrides: number;
    lowCostAccounts: number;
    highCostAccounts: number;
    unknownCostAccounts: number;
    xOnlyMedia: number;
    workersPaidEnabled: string;
  },
  language: Language,
): string {
  return [
    t(language, "status_default_credentials_saved", {
      value: input.defaultCredentialsSaved ? t(language, "common_yes") : t(language, "common_no"),
    }),
    t(language, "status_connected_accounts", {
      count: input.connectedAccounts,
    }),
    t(language, "status_active_accounts", {
      count: input.activeAccounts,
    }),
    t(language, "status_account_api_credentials", {
      count: input.accountCredentialOverrides,
    }),
    t(language, "status_low_cost_accounts", {
      count: input.lowCostAccounts,
    }),
    t(language, "status_high_cost_accounts", {
      count: input.highCostAccounts,
    }),
    t(language, "status_unknown_cost_accounts", {
      count: input.unknownCostAccounts,
    }),
    t(language, "status_x_only_media", {
      count: input.xOnlyMedia,
    }),
    t(language, "status_workers_paid_enabled", {
      value: input.workersPaidEnabled,
    }),
  ].join("\n");
}

export function buildStatusKeyboard(hasAccounts: boolean, language: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(getMenuActionLabel("accounts", language), `${CALLBACK_PREFIX}:nav:accounts`)
    .text(getMenuActionLabel("polling", language), `${CALLBACK_PREFIX}:nav:polling`);

  if (hasAccounts) {
    keyboard.row().text(t(language, "accounts_save_all_active_button"), `${CALLBACK_PREFIX}:save:all`);
  }

  return keyboard.row().text(getMenuActionLabel("language", language), `${CALLBACK_PREFIX}:nav:language`);
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
  const [language, user, accounts] = await Promise.all([
    getUserLanguage(deps.env, chatId),
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
  ]);
  if (accounts.length === 0) {
    await updateInlineMessage(ctx, t(language, "accounts_empty"));
    return;
  }

  await updateInlineMessage(
    ctx,
    buildAccountsMessage(accounts, language, user),
    buildAccountsKeyboard(accounts, language),
  );
}

async function showPollingDashboard(ctx: Context, deps: CommandDependencies, chatId: number): Promise<void> {
  const [language, user, accounts] = await Promise.all([
    getUserLanguage(deps.env, chatId),
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
  ]);
  if (accounts.length === 0) {
    await updateInlineMessage(ctx, t(language, "accounts_empty"));
    return;
  }

  await updateInlineMessage(
    ctx,
    buildPollingDashboardMessage(accounts, language, user),
    buildPollingListKeyboard(accounts, language),
  );
}

async function showPollingAccountView(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
): Promise<void> {
  const [language, user, account] = await Promise.all([
    getUserLanguage(deps.env, chatId),
    deps.db.getUser(chatId),
    getOwnedAccount(deps, chatId, accountId),
  ]);
  if (!account) {
    await updateInlineMessage(ctx, t(language, "error_account_not_found"));
    return;
  }

  await updateInlineMessage(
    ctx,
    buildPollingAccountMessage(account, language, user),
    buildPollingAccountKeyboard(account, language),
  );
}

async function showStatusView(ctx: Context, deps: CommandDependencies, chatId: number): Promise<void> {
  const language = await getUserLanguage(deps.env, chatId);
  const [user, accounts, xOnlyMedia] = await Promise.all([
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
    deps.db.listMediaByStatus("x_only", chatId, 100),
  ]);
  const usage = accounts.map((account) => resolveCredentialUsage(account, user));

  await updateInlineMessage(
    ctx,
    formatStatusMessage(
      {
        defaultCredentialsSaved: Boolean(user),
        connectedAccounts: accounts.length,
        activeAccounts: accounts.filter((account) => account.is_active === 1).length,
        accountCredentialOverrides: usage.filter((item) => item.source === "account-specific").length,
        lowCostAccounts: usage.filter((item) => item.costLevel === "low").length,
        highCostAccounts: usage.filter((item) => item.costLevel === "high").length,
        unknownCostAccounts: usage.filter((item) => item.costLevel === "unknown").length,
        xOnlyMedia: xOnlyMedia.length,
        workersPaidEnabled: deps.env.WORKERS_PAID_ENABLED ?? "false",
      },
      language,
    ),
    buildStatusKeyboard(accounts.length > 0, language),
  );
}

async function showLanguageView(ctx: Context, language: Language): Promise<void> {
  await updateInlineMessage(ctx, buildLanguageMenuMessage(language), buildLanguageMenuKeyboard(language));
}

async function runManualSaveForAccount(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
): Promise<void> {
  const language = await getUserLanguage(deps.env, chatId);
  const account = await getOwnedAccount(deps, chatId, accountId);
  if (!account) {
    await ctx.answerCallbackQuery({
      text: t(language, "error_account_not_found"),
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: t(language, "manual_save_account_toast", {
      username: account.username,
    }),
  });
  await ctx.reply(
    t(language, "manual_save_account_started", {
      username: account.username,
    }),
  );
  await pollAccount(deps.env, account);

  const updated = await deps.db.getAccount(accountId);
  if (updated) {
    const user = await deps.db.getUser(chatId);
    await updateInlineMessage(
      ctx,
      buildPollingAccountMessage(updated, language, user),
      buildPollingAccountKeyboard(updated, language),
    );
  }
  await ctx.reply(
    t(language, "manual_save_account_finished", {
      username: account.username,
    }),
  );
}

async function runManualSaveForAll(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
): Promise<void> {
  const language = await getUserLanguage(deps.env, chatId);
  const accounts = (await deps.db.listAccountsByUser(chatId)).filter((account) => account.is_active === 1);
  if (accounts.length === 0) {
    await ctx.answerCallbackQuery({
      text: t(language, "no_active_accounts"),
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: t(language, "manual_save_all_toast", {
      count: accounts.length,
    }),
  });
  await ctx.reply(
    t(language, "manual_save_all_started", {
      count: accounts.length,
    }),
  );
  for (const account of accounts) {
    await pollAccount(deps.env, account);
  }
  await ctx.reply(
    t(language, "manual_save_all_finished", {
      count: accounts.length,
    }),
  );
}

export function registerUiCallbacks(bot: Bot, deps: CommandDependencies): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(`${CALLBACK_PREFIX}:`)) {
      return;
    }

    const chatId = getChatId(ctx);
    const fallbackLanguage = normalizeLanguage(ctx.from?.language_code) ?? DEFAULT_LANGUAGE;
    if (!chatId) {
      await ctx.answerCallbackQuery({
        text: t(fallbackLanguage, "error_chat_not_found"),
        show_alert: true,
      });
      return;
    }

    const currentLanguage = await getUserLanguage(deps.env, chatId);
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
      if (parts[2] === "language") {
        await showLanguageView(ctx, currentLanguage);
        return;
      }
    }

    if (parts[1] === "lang") {
      if (parts[2] === "set") {
        const selectedLanguage = normalizeLanguage(parts[3]);
        if (!selectedLanguage) {
          await ctx.answerCallbackQuery({
            text: t(currentLanguage, "language_invalid"),
            show_alert: true,
          });
          return;
        }

        await setUserLanguage(deps.env, chatId, selectedLanguage);
        await ctx.answerCallbackQuery({
          text: t(selectedLanguage, "language_updated", {
            language: getLanguageLabel(selectedLanguage, selectedLanguage),
          }),
        });
        await updateInlineMessage(
          ctx,
          buildLanguageMenuMessage(selectedLanguage),
          buildLanguageMenuKeyboard(selectedLanguage),
        );
        await ctx.reply(
          t(selectedLanguage, "language_updated", {
            language: getLanguageLabel(selectedLanguage, selectedLanguage),
          }),
          {
            reply_markup: buildMainMenuKeyboard(selectedLanguage),
          },
        );
        await syncChatCommands(ctx, chatId, selectedLanguage);
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
          text: t(currentLanguage, "error_missing_account_id"),
          show_alert: true,
        });
        return;
      }

      const account = await getOwnedAccount(deps, chatId, accountId);
      if (!account) {
        await ctx.answerCallbackQuery({
          text: t(currentLanguage, "error_account_not_found"),
          show_alert: true,
        });
        return;
      }
      const user = await deps.db.getUser(chatId);

      if (parts[2] === "view") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(
          ctx,
          buildPollingAccountMessage(account, currentLanguage, user),
          buildPollingAccountKeyboard(account, currentLanguage),
        );
        return;
      }

      if (parts[2] === "toggle") {
        await deps.db.setAccountActive(account.account_id, account.is_active !== 1);
        const updated = await deps.db.getAccount(account.account_id);
        await ctx.answerCallbackQuery({
          text: updated?.is_active === 1 ? t(currentLanguage, "polling_enabled") : t(currentLanguage, "polling_disabled"),
        });
        if (updated) {
          await updateInlineMessage(
            ctx,
            buildPollingAccountMessage(updated, currentLanguage, user),
            buildPollingAccountKeyboard(updated, currentLanguage),
          );
        }
        return;
      }

      if (parts[2] === "interval-menu") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(
          ctx,
          buildIntervalMenuMessage(account, currentLanguage),
          buildIntervalMenuKeyboard(accountId, currentLanguage),
        );
        return;
      }

      if (parts[2] === "set-interval") {
        const minutes = Number(parts[4]);
        if (!Number.isSafeInteger(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES) {
          await ctx.answerCallbackQuery({
            text: t(currentLanguage, "error_invalid_interval"),
            show_alert: true,
          });
          return;
        }

        await deps.db.updateAccount(accountId, {
          poll_interval_min: minutes,
        });
        const updated = await deps.db.getAccount(accountId);
        await ctx.answerCallbackQuery({
          text: t(currentLanguage, "polling_interval_set", {
            minutes,
          }),
        });
        if (updated) {
          await updateInlineMessage(
            ctx,
            buildPollingAccountMessage(updated, currentLanguage, user),
            buildPollingAccountKeyboard(updated, currentLanguage),
          );
        }
        return;
      }

      if (parts[2] === "hours-menu") {
        await ctx.answerCallbackQuery();
        await updateInlineMessage(
          ctx,
          buildHoursMenuMessage(account, currentLanguage),
          buildHoursMenuKeyboard(accountId, currentLanguage),
        );
        return;
      }

      if (parts[2] === "set-hours") {
        const value = parts[4];
        const hours = value ? parseHoursRange(value) : null;
        if (!hours) {
          await ctx.answerCallbackQuery({
            text: t(currentLanguage, "error_invalid_hour_range"),
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
          text: t(currentLanguage, "polling_hours_set", {
            start: hours.start,
            end: hours.end,
          }),
        });
        if (updated) {
          await updateInlineMessage(
            ctx,
            buildPollingAccountMessage(updated, currentLanguage, user),
            buildPollingAccountKeyboard(updated, currentLanguage),
          );
        }
        return;
      }
    }

    await ctx.answerCallbackQuery({
      text: t(currentLanguage, "error_unsupported_action"),
      show_alert: true,
    });
  });
}
