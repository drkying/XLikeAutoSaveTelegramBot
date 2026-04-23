import type { Bot, Context } from "grammy";
import { t } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { CommandDependencies } from "./helpers";
import {
  MIN_POLL_INTERVAL_MINUTES,
  getChatId,
  getCommandArgs,
  getOwnedAccount,
  parseHoursRange,
} from "./helpers";
import {
  buildMainMenuKeyboard,
  buildPollingAccountKeyboard,
  buildPollingAccountMessage,
  buildPollingDashboardMessage,
  buildPollingListKeyboard,
} from "./ui";

export async function handlePollingCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [action = "list", accountId, value] = getCommandArgs(inputText);
  if (action === "list") {
    const [user, accounts] = await Promise.all([
      deps.db.getUser(chatId),
      deps.db.listAccountsByUser(chatId),
    ]);
    if (accounts.length === 0) {
      await ctx.reply(t(language, "accounts_empty"), {
        reply_markup: buildMainMenuKeyboard(language),
      });
      return;
    }
    await ctx.reply(buildPollingDashboardMessage(accounts, language, user), {
      reply_markup: buildPollingListKeyboard(accounts, language),
    });
    return;
  }

  if (!accountId) {
    await ctx.reply(t(language, "polling_usage"));
    return;
  }

  const account = await getOwnedAccount(deps, chatId, accountId);
  if (!account) {
    await ctx.reply(t(language, "error_account_not_found"));
    return;
  }
  const user = await deps.db.getUser(chatId);

  if (action === "on" || action === "off") {
    await deps.db.setAccountActive(accountId, action === "on");
    const updated = await deps.db.getAccount(accountId);
    if (!updated) {
      await ctx.reply(t(language, "error_account_not_found"));
      return;
    }
    await ctx.reply(buildPollingAccountMessage(updated, language, user), {
      reply_markup: buildPollingAccountKeyboard(updated, language),
    });
    return;
  }

  if (action === "interval") {
    const minutes = Number(value);
    if (!Number.isSafeInteger(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES) {
      await ctx.reply(
        t(language, "polling_interval_usage", {
          minimum: MIN_POLL_INTERVAL_MINUTES,
        }),
      );
      return;
    }
    await deps.db.updateAccount(accountId, { poll_interval_min: minutes });
    const updated = await deps.db.getAccount(accountId);
    if (!updated) {
      await ctx.reply(t(language, "error_account_not_found"));
      return;
    }
    await ctx.reply(buildPollingAccountMessage(updated, language, user), {
      reply_markup: buildPollingAccountKeyboard(updated, language),
    });
    return;
  }

  if (action === "hours") {
    if (!value) {
      await ctx.reply(t(language, "polling_hours_usage"));
      return;
    }
    const hours = parseHoursRange(value);
    if (!hours) {
      await ctx.reply(t(language, "polling_invalid_hours_example"));
      return;
    }
    await deps.db.updatePollingSettings(accountId, {
      poll_interval_min: account.poll_interval_min,
      poll_start_hour: hours.start,
      poll_end_hour: hours.end,
    });
    const updated = await deps.db.getAccount(accountId);
    if (!updated) {
      await ctx.reply(t(language, "error_account_not_found"));
      return;
    }
    await ctx.reply(buildPollingAccountMessage(updated, language, user), {
      reply_markup: buildPollingAccountKeyboard(updated, language),
    });
    return;
  }

  await ctx.reply(t(language, "polling_unknown_action"));
}

export function registerPollingCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("polling", async (ctx) => {
    await handlePollingCommand(ctx, deps);
  });
}
