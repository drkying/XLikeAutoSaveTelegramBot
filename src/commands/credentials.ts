import type { Bot, Context } from "grammy";
import { getCredentialCostLevel, getCredentialKey, resolveCredentialUsage } from "../credential-ownership";
import { t, type Language } from "../i18n";
import { getUserLanguage } from "../language-store";
import type { AccountData, UserData } from "../types";
import type { CommandDependencies } from "./helpers";
import { formatCredentialCostLabel, formatCredentialOwnerLabel, getChatId, getCommandArgs, getOwnedAccount } from "./helpers";
import { buildMainMenuKeyboard } from "./ui";

interface CredentialGroup {
  credentialKey: string;
  clientId: string;
  accounts: AccountData[];
  isDefault: boolean;
  ownerAccountId: string | null;
}

function maskClientId(clientId: string): string {
  if (clientId.length <= 8) {
    return `${clientId.slice(0, 2)}***${clientId.slice(-2)}`;
  }

  return `${clientId.slice(0, 4)}...${clientId.slice(-4)}`;
}

function buildCredentialGroups(
  user: UserData | null,
  accounts: AccountData[],
): CredentialGroup[] {
  const groups: CredentialGroup[] = [];
  const userCredentialKey = getCredentialKey(user?.x_client_id, user?.x_client_secret);

  if (user && userCredentialKey) {
    const defaultAccounts = accounts.filter((account) => resolveCredentialUsage(account, user).credentialKey === userCredentialKey);
    groups.push({
      credentialKey: userCredentialKey,
      clientId: user.x_client_id,
      accounts: defaultAccounts,
      isDefault: true,
      ownerAccountId: user.credential_owner_account_id
        ?? defaultAccounts
          .map((account) => resolveCredentialUsage(account, user).ownerAccountId)
          .find((ownerAccountId): ownerAccountId is string => Boolean(ownerAccountId))
        ?? null,
    });
  }

  const customGroups = new Map<string, CredentialGroup>();
  for (const account of accounts) {
    const usage = resolveCredentialUsage(account, user);
    if (!usage.credentialKey || !usage.clientId || usage.credentialKey === userCredentialKey) {
      continue;
    }

    const existing = customGroups.get(usage.credentialKey);
    if (existing) {
      existing.accounts.push(account);
      if (!existing.ownerAccountId && usage.ownerAccountId) {
        existing.ownerAccountId = usage.ownerAccountId;
      }
      continue;
    }

    customGroups.set(usage.credentialKey, {
      credentialKey: usage.credentialKey,
      clientId: usage.clientId,
      accounts: [account],
      isDefault: false,
      ownerAccountId: usage.ownerAccountId,
    });
  }

  return [...groups, ...customGroups.values()];
}

function formatAccountList(
  accounts: AccountData[],
  ownerAccountId: string | null,
  language: Language,
): string {
  if (accounts.length === 0) {
    return t(language, "credentials_accounts_none");
  }

  return accounts
    .map((account) => t(language, "credentials_account_item", {
      username: account.username,
      accountId: account.account_id,
      cost: formatCredentialCostLabel(getCredentialCostLevel(account.account_id, ownerAccountId), language),
    }))
    .join(", ");
}

function formatCredentialGroup(
  group: CredentialGroup,
  customIndex: number,
  language: Language,
): string {
  return [
    group.isDefault
      ? t(language, "credentials_default_label")
      : t(language, "credentials_custom_label", { index: customIndex }),
    t(language, "credentials_client_id_line", {
      clientId: maskClientId(group.clientId),
    }),
    t(language, "credentials_owner_line", {
      ownerAccountId: formatCredentialOwnerLabel(group.ownerAccountId, language),
    }),
    t(language, "credentials_accounts_line", {
      accounts: formatAccountList(group.accounts, group.ownerAccountId, language),
    }),
  ].join("\n");
}

async function showCredentialList(ctx: Context, deps: CommandDependencies, chatId: number, language: Language): Promise<void> {
  const [user, accounts] = await Promise.all([
    deps.db.getUser(chatId),
    deps.db.listAccountsByUser(chatId),
  ]);

  const groups = buildCredentialGroups(user, accounts);
  if (groups.length === 0) {
    await ctx.reply(t(language, "credentials_empty"), {
      reply_markup: buildMainMenuKeyboard(language),
    });
    return;
  }

  let customIndex = 0;
  const sections = groups.map((group) => {
    if (group.isDefault) {
      return formatCredentialGroup(group, 0, language);
    }

    customIndex += 1;
    return formatCredentialGroup(group, customIndex, language);
  });
  await ctx.reply(
    [
      t(language, "credentials_title"),
      "",
      ...sections,
      "",
      t(language, "credentials_hint_setup_default"),
      t(language, "credentials_hint_setup_account"),
      t(language, "credentials_hint_clear"),
    ].join("\n"),
    {
      reply_markup: buildMainMenuKeyboard(language),
    },
  );
}

async function clearAccountCredentialOverride(
  ctx: Context,
  deps: CommandDependencies,
  chatId: number,
  accountId: string,
  language: Language,
): Promise<void> {
  const account = await getOwnedAccount(deps, chatId, accountId);
  if (!account) {
    await ctx.reply(t(language, "error_account_not_found"));
    return;
  }

  if (!account.x_client_id || !account.x_client_secret) {
    await ctx.reply(t(language, "credentials_no_override", {
      username: account.username,
    }));
    return;
  }

  await deps.db.updateAccount(accountId, {
    x_client_id: null,
    x_client_secret: null,
    credential_owner_account_id: null,
  });
  const user = await deps.db.getUser(chatId);
  await ctx.reply(
    t(language, user ? "credentials_clear_done" : "credentials_clear_done_without_default", {
      username: account.username,
    }),
  );
}

export async function handleCredentialsCommand(
  ctx: Context,
  deps: CommandDependencies,
  inputText = ctx.message?.text,
): Promise<void> {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const language = await getUserLanguage(deps.env, chatId);
  const [action = "list", accountId] = getCommandArgs(inputText);
  if (action === "list") {
    await showCredentialList(ctx, deps, chatId, language);
    return;
  }

  if (action === "clear" && accountId) {
    await clearAccountCredentialOverride(ctx, deps, chatId, accountId, language);
    return;
  }

  await ctx.reply(t(language, "credentials_usage"));
}

export function registerCredentialsCommand(bot: Bot, deps: CommandDependencies): void {
  bot.command("credentials", async (ctx) => {
    await handleCredentialsCommand(ctx, deps);
  });
}
