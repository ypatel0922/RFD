/**
 * Account classification.
 *
 * Analytics has to know whether an account holds the department's money or
 * represents money it owes, because a credit card balance must be subtracted
 * from the net position rather than added to available cash.
 *
 * An account's kind is only ever read from something a person recorded:
 *
 *   1. `bank_accounts.account_type`, set from the Analytics account setup step
 *   2. the account type captured for it during onboarding
 *   3. the type and subtype Plaid reports for a linked account
 *
 * When none of those exist the account stays `unclassified` and the dashboard
 * asks someone to classify it. The account's *name* is never used to guess:
 * an account called "2% Checking" tells us nothing reliable, and the 2%
 * designation already has a real column (`is_two_percent_account`).
 */

import type {
  AccountKind,
  AccountKindSource,
  AnalyticsBankAccountRow,
  AnalyticsExternalAccountRow,
  AnalyticsOpeningBalanceRow,
  ClassifiedAccount,
  FundDesignation,
} from "./types";

export function normalizeAccountName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Account-type wording that means the department holds money here. */
const ASSET_TYPE_PATTERNS = [
  /^checking/,
  /^savings/,
  /money\s*market/,
  /^cash/,
  /petty\s*cash/,
  /^depository/,
  /^cd$/,
  /certificate\s*of\s*deposit/,
  /^2%\s*funds?$/,
  /^brokerage/,
  /^investment/,
];

/** Account-type wording that means the department owes money here. */
const LIABILITY_TYPE_PATTERNS = [
  /credit\s*card/,
  /^credit$/,
  /line\s*of\s*credit/,
  /^loan/,
  /^liability/,
  /^payable/,
];

function kindFromTypeText(value: string | null | undefined): AccountKind {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return "unclassified";
  // Liability is checked first: "credit card checking rewards" is a card.
  if (LIABILITY_TYPE_PATTERNS.some((pattern) => pattern.test(text))) return "liability";
  if (ASSET_TYPE_PATTERNS.some((pattern) => pattern.test(text))) return "asset";
  return "unclassified";
}

const FUND_TYPE_MAP: Array<{ pattern: RegExp; fund: FundDesignation }> = [
  { pattern: /nys_2_percent|two_percent|2_percent/, fund: "two_percent" },
  { pattern: /capital|reserve/, fund: "capital_reserve" },
  { pattern: /grant/, fund: "grant" },
  { pattern: /fundrais/, fund: "fundraiser" },
  { pattern: /restrict|designat/, fund: "restricted" },
  { pattern: /operating|general/, fund: "operating" },
];

function fundFromRow(row: AnalyticsBankAccountRow): FundDesignation {
  if (row.is_two_percent_account) return "two_percent";
  const value = (row.fund_type ?? "").trim().toLowerCase();
  if (!value) return "unspecified";
  for (const entry of FUND_TYPE_MAP) {
    if (entry.pattern.test(value)) return entry.fund;
  }
  return "unspecified";
}

export const FUND_LABELS: Record<FundDesignation, string> = {
  two_percent: "2% funds",
  operating: "Operating",
  capital_reserve: "Capital reserve",
  grant: "Grant",
  fundraiser: "Fundraiser",
  restricted: "Restricted",
  unspecified: "Not designated",
};

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  asset: "Asset",
  liability: "Liability",
  unclassified: "Not classified",
};

/** Account type choices offered by the Analytics account setup step. */
export const ACCOUNT_TYPE_OPTIONS = [
  { value: "Checking", kind: "asset" as const },
  { value: "Savings", kind: "asset" as const },
  { value: "Money Market", kind: "asset" as const },
  { value: "Cash", kind: "asset" as const },
  { value: "Petty Cash", kind: "asset" as const },
  { value: "Credit Card", kind: "liability" as const },
  { value: "Line of Credit", kind: "liability" as const },
];

export const FUND_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Not designated" },
  { value: "operating", label: "Operating" },
  { value: "capital_reserve", label: "Capital reserve" },
  { value: "grant", label: "Grant" },
  { value: "fundraiser", label: "Fundraiser" },
  { value: "restricted", label: "Restricted or board-designated" },
];

export type AccountClassificationInput = {
  bankAccounts: AnalyticsBankAccountRow[];
  externalAccounts?: AnalyticsExternalAccountRow[];
  openingBalances?: AnalyticsOpeningBalanceRow[];
};

export function classifyAccounts(input: AccountClassificationInput): ClassifiedAccount[] {
  const openingByAccountId = new Map<string, AnalyticsOpeningBalanceRow>();
  const openingByName = new Map<string, AnalyticsOpeningBalanceRow>();
  for (const row of input.openingBalances ?? []) {
    if (row.account_id) openingByAccountId.set(row.account_id, row);
    const key = normalizeAccountName(row.account_name);
    if (key && !openingByName.has(key)) openingByName.set(key, row);
  }

  const plaidByName = new Map<string, AnalyticsExternalAccountRow>();
  const plaidByMask = new Map<string, AnalyticsExternalAccountRow>();
  for (const row of input.externalAccounts ?? []) {
    const key = normalizeAccountName(row.name);
    if (key && !plaidByName.has(key)) plaidByName.set(key, row);
    const mask = (row.mask ?? "").trim();
    if (mask && !plaidByMask.has(mask)) plaidByMask.set(mask, row);
  }

  return input.bankAccounts.map((row) => {
    const normalizedName = normalizeAccountName(row.name);
    let kind = kindFromTypeText(row.account_type);
    let kindSource: AccountKindSource = kind === "unclassified" ? "unknown" : "bank_account_type";
    let kindLabel = kind === "unclassified" ? null : (row.account_type ?? null);

    if (kind === "unclassified") {
      const opening = openingByAccountId.get(row.id) ?? openingByName.get(normalizedName);
      const openingKind = kindFromTypeText(opening?.account_type);
      if (openingKind !== "unclassified") {
        kind = openingKind;
        kindSource = "opening_balance";
        kindLabel = opening?.account_type ?? null;
      }
    }

    if (kind === "unclassified") {
      const mask = (row.account_mask ?? "").trim();
      const plaid = plaidByName.get(normalizedName) ?? (mask ? plaidByMask.get(mask) : undefined);
      // Plaid's subtype ("credit card", "checking") is more specific than its
      // type ("credit", "depository"), so it is consulted first.
      const plaidKind =
        kindFromTypeText(plaid?.subtype) !== "unclassified"
          ? kindFromTypeText(plaid?.subtype)
          : kindFromTypeText(plaid?.type);
      if (plaidKind !== "unclassified") {
        kind = plaidKind;
        kindSource = "plaid";
        kindLabel = plaid?.subtype ?? plaid?.type ?? null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      normalizedName,
      institutionName: row.institution_name,
      mask: row.account_mask,
      kind,
      kindSource,
      kindLabel,
      fund: fundFromRow(row),
      isTwoPercent: row.is_two_percent_account,
      isDefault: row.is_default,
      lastReconciledAt: row.last_reconciled_at,
    };
  });
}

/** Lookup from a transaction's free-text `bank_account_name` to an account. */
export function accountsByName(
  accounts: ClassifiedAccount[],
): Map<string, ClassifiedAccount> {
  const map = new Map<string, ClassifiedAccount>();
  for (const account of accounts) {
    if (account.normalizedName) map.set(account.normalizedName, account);
  }
  return map;
}

export function hasUnclassifiedAccounts(accounts: ClassifiedAccount[]): boolean {
  return accounts.some((account) => account.kind === "unclassified");
}

export function twoPercentAccounts(accounts: ClassifiedAccount[]): ClassifiedAccount[] {
  return accounts.filter((account) => account.isTwoPercent);
}
