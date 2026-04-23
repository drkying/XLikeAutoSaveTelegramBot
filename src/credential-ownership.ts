import type { Database } from "./db";
import type { AccountData, UserData } from "./types";

export type CredentialCostLevel = "low" | "high" | "unknown";
export type CredentialSource = "account-specific" | "default/fallback" | "none";

export interface CredentialUsageInfo {
  clientId: string | null;
  clientSecret: string | null;
  credentialKey: string | null;
  ownerAccountId: string | null;
  source: CredentialSource;
  costLevel: CredentialCostLevel;
}

export function getCredentialKey(
  clientId?: string | null,
  clientSecret?: string | null,
): string | null {
  if (!clientId || !clientSecret) {
    return null;
  }

  return `${clientId}\u0000${clientSecret}`;
}

export function findKnownCredentialOwnerAccountId(
  clientId: string,
  clientSecret: string,
  user: UserData | null,
  accounts: AccountData[],
): string | null {
  const credentialKey = getCredentialKey(clientId, clientSecret);
  if (!credentialKey) {
    return null;
  }

  if (
    credentialKey === getCredentialKey(user?.x_client_id, user?.x_client_secret) &&
    user?.credential_owner_account_id
  ) {
    return user.credential_owner_account_id;
  }

  for (const account of accounts) {
    if (
      credentialKey === getCredentialKey(account.x_client_id, account.x_client_secret) &&
      account.credential_owner_account_id
    ) {
      return account.credential_owner_account_id;
    }
  }

  return null;
}

export async function findKnownCredentialOwnerAccountIdInChat(
  db: Database,
  chatId: number,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const [user, accounts] = await Promise.all([
    db.getUser(chatId),
    db.listAccountsByUser(chatId),
  ]);

  return findKnownCredentialOwnerAccountId(clientId, clientSecret, user, accounts);
}

export async function syncCredentialOwnerAcrossChatBindings(
  db: Database,
  chatId: number,
  clientId: string,
  clientSecret: string,
  ownerAccountId: string | null,
): Promise<void> {
  if (!ownerAccountId) {
    return;
  }

  const credentialKey = getCredentialKey(clientId, clientSecret);
  if (!credentialKey) {
    return;
  }

  const [user, accounts] = await Promise.all([
    db.getUser(chatId),
    db.listAccountsByUser(chatId),
  ]);

  if (
    user &&
    credentialKey === getCredentialKey(user.x_client_id, user.x_client_secret) &&
    user.credential_owner_account_id !== ownerAccountId
  ) {
    await db.updateUser(chatId, {
      x_client_id: user.x_client_id,
      x_client_secret: user.x_client_secret,
      credential_owner_account_id: ownerAccountId,
    });
  }

  for (const account of accounts) {
    if (
      credentialKey !== getCredentialKey(account.x_client_id, account.x_client_secret) ||
      account.credential_owner_account_id === ownerAccountId
    ) {
      continue;
    }

    await db.updateAccount(account.account_id, {
      credential_owner_account_id: ownerAccountId,
    });
  }
}

export function resolveCredentialUsage(
  account: AccountData,
  user?: UserData | null,
): CredentialUsageInfo {
  const accountKey = getCredentialKey(account.x_client_id, account.x_client_secret);
  const userKey = getCredentialKey(user?.x_client_id, user?.x_client_secret);

  if (accountKey && userKey && accountKey === userKey) {
    const ownerAccountId = account.credential_owner_account_id ?? user?.credential_owner_account_id ?? null;
    return {
      clientId: account.x_client_id ?? user?.x_client_id ?? null,
      clientSecret: account.x_client_secret ?? user?.x_client_secret ?? null,
      credentialKey: accountKey,
      ownerAccountId,
      source: "default/fallback",
      costLevel: getCredentialCostLevel(account.account_id, ownerAccountId),
    };
  }

  if (accountKey) {
    return {
      clientId: account.x_client_id ?? null,
      clientSecret: account.x_client_secret ?? null,
      credentialKey: accountKey,
      ownerAccountId: account.credential_owner_account_id ?? null,
      source: "account-specific",
      costLevel: getCredentialCostLevel(account.account_id, account.credential_owner_account_id ?? null),
    };
  }

  if (userKey) {
    return {
      clientId: user?.x_client_id ?? null,
      clientSecret: user?.x_client_secret ?? null,
      credentialKey: userKey,
      ownerAccountId: user?.credential_owner_account_id ?? null,
      source: "default/fallback",
      costLevel: getCredentialCostLevel(account.account_id, user?.credential_owner_account_id ?? null),
    };
  }

  return {
    clientId: null,
    clientSecret: null,
    credentialKey: null,
    ownerAccountId: null,
    source: "none",
    costLevel: "unknown",
  };
}

export function getCredentialCostLevel(
  accountId: string,
  ownerAccountId?: string | null,
): CredentialCostLevel {
  if (!ownerAccountId) {
    return "unknown";
  }

  return ownerAccountId === accountId ? "low" : "high";
}
