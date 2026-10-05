"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { logAuditFromBrowser } from "../../lib/audit";
import { supabase } from "../../lib/supabase";
import type { BankAccount, DepartmentMembership, ExpenseRecord } from "../../lib/types";
import { insertLedgerRows, linkExternalTransaction, updateLedgerRow } from "../../lib/money-in/persist";
import {
  bankCreditPrefill,
  bankSignedCents,
  classifyBankCredit,
  findMoneyInBankMatches,
  findTransferPair,
  isOpenBankCredit,
  type BankAccountRef,
  type BankActivityRow,
  type MoneyInBankMatch,
  type TransferPair,
} from "../../lib/money-in/plaid";
import { buildTransferLedgerRows, emptyMoneyInForm } from "../../lib/money-in/record";
import type { MoneyInPrefill } from "./money-in-page";

const LOOKBACK_DAYS = 120;
const COLLAPSED_COUNT = 4;

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatUsd(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatDate(iso: string | null | undefined) {
  const day = (iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function loggedByLabel(user: User) {
  const name = user.user_metadata?.full_name != null ? String(user.user_metadata.full_name).trim() : "";
  const email = user.email || "";
  if (name && email) return `${name} (${email})`;
  return email || user.id;
}

/** Prefer the department's own name for a linked bank account. */
function displayAccount(
  external: BankAccountRef | undefined,
  bankAccounts: BankAccount[],
): BankAccountRef | undefined {
  if (!external) return undefined;
  const byName = bankAccounts.find((a) => a.name.trim().toLowerCase() === external.name.trim().toLowerCase());
  const byMask = external.mask ? bankAccounts.find((a) => a.account_mask && a.account_mask === external.mask) : undefined;
  const own = byName ?? byMask;
  return own ? { id: external.id, name: own.name, mask: external.mask } : external;
}

/**
 * Incoming bank credits that are not yet tied to a ledger record. Each one is
 * offered a likely Money In match, an unambiguous internal transfer, or a
 * shortcut to record it — never auto-finalized.
 */
export function BankDepositsPanel({
  membership,
  user,
  expenses,
  bankAccounts,
  onExpensesChanged,
  onRecordMoneyIn,
  showErrorMessage,
  showSuccessMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  onExpensesChanged: () => Promise<void>;
  onRecordMoneyIn: (prefill: MoneyInPrefill) => void;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const departmentId = membership.department_id;
  const [rows, setRows] = useState<BankActivityRow[]>([]);
  const [accounts, setAccounts] = useState<BankAccountRef[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [txResult, accountResult] = await Promise.all([
        supabase
          .from("external_transactions")
          .select("id,external_transaction_id,external_account_id,posted_date,description,amount,pending,expense_id,match_status")
          .eq("department_id", departmentId)
          .is("expense_id", null)
          .gte("posted_date", isoDaysAgo(LOOKBACK_DAYS))
          .order("posted_date", { ascending: false })
          .limit(500),
        supabase.from("external_accounts").select("id,name,mask").eq("department_id", departmentId),
      ]);
      if (cancelled) return;
      setRows(txResult.error ? [] : ((txResult.data || []) as BankActivityRow[]));
      setAccounts(accountResult.error ? [] : ((accountResult.data || []) as BankAccountRef[]));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [departmentId, reloadKey, expenses]);

  const accountsById = useMemo(() => {
    const map = new Map<string, BankAccountRef>();
    for (const account of accounts) {
      const shown = displayAccount(account, bankAccounts);
      if (shown) map.set(account.id, shown);
    }
    return map;
  }, [accounts, bankAccounts]);

  const credits = useMemo(() => {
    return rows
      .filter(isOpenBankCredit)
      .map((credit) => {
        const transfer = findTransferPair(credit, rows);
        const matches: MoneyInBankMatch[] = transfer
          ? []
          : findMoneyInBankMatches(credit, expenses, { accountsById, departmentId });
        return { credit, transfer, best: matches[0] ?? null, kind: classifyBankCredit(credit.description) };
      });
  }, [rows, expenses, accountsById, departmentId]);

  const refresh = useCallback(async () => {
    setReloadKey((k) => k + 1);
    await onExpensesChanged();
  }, [onExpensesChanged]);

  async function confirmMatch(credit: BankActivityRow, match: MoneyInBankMatch) {
    setBusyId(credit.id);
    try {
      const record = match.record;
      const cents = Math.abs(bankSignedCents(credit) ?? 0);
      const account = credit.external_account_id ? accountsById.get(credit.external_account_id) : undefined;
      const { error } = await updateLedgerRow(record.id, departmentId, {
        reconciliation_status: "matched",
        bank_transaction_id: credit.external_transaction_id,
        bank_posted_date: credit.posted_date,
        bank_description: credit.description,
        bank_amount: -cents / 100,
        bank_match_confidence: Number(match.score.toFixed(3)),
        reconciled_at: new Date().toISOString(),
        deposit_status: "deposited",
        deposit_date: record.deposit_date || credit.posted_date,
        bank_account_name: record.bank_account_name || account?.name || null,
      });
      if (error) throw error;
      const link = await linkExternalTransaction({ departmentId, externalRowId: credit.id, expenseId: record.id });
      if (link.error) throw link.error;
      void logAuditFromBrowser({
        departmentId,
        userRole: membership.role,
        action: "money_in.bank_matched",
        resourceType: "expense",
        resourceId: record.id,
        resourceLabel: record.payee || undefined,
        afterData: { reconciliation_status: "matched", bank_posted_date: credit.posted_date },
        metadata: { externalTransactionId: credit.external_transaction_id, reasons: match.reasons },
      });
      showSuccessMessage("Matched to the bank deposit. It now counts once.");
      await refresh();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not match this deposit.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmTransfer(pair: TransferPair) {
    const fromAccount = pair.debit.external_account_id ? accountsById.get(pair.debit.external_account_id) : undefined;
    const toAccount = pair.credit.external_account_id ? accountsById.get(pair.credit.external_account_id) : undefined;
    if (!fromAccount || !toAccount) {
      showErrorMessage("Both accounts must be linked to confirm a transfer.");
      return;
    }
    setBusyId(pair.credit.id);
    try {
      const cents = Math.abs(bankSignedCents(pair.credit) ?? 0);
      const outId = crypto.randomUUID();
      const inId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      const values = emptyMoneyInForm({
        mode: "transfer",
        date_received: (pair.credit.posted_date || "").slice(0, 10),
        amount_cents: cents,
        deposit_account: toAccount.name,
        transfer_from_account: fromAccount.name,
        category: "",
      });
      const legs = buildTransferLedgerRows({
        outId,
        inId,
        groupId,
        departmentId,
        values,
        actor: { id: user.id, email: user.email || "", label: loggedByLabel(user) },
        bankLegs: {
          out: {
            externalTransactionId: pair.debit.external_transaction_id,
            postedDate: pair.debit.posted_date,
            description: pair.debit.description,
            amountCents: cents,
          },
          in: {
            externalTransactionId: pair.credit.external_transaction_id,
            postedDate: pair.credit.posted_date,
            description: pair.credit.description,
            amountCents: cents,
          },
        },
      });
      const { error } = await insertLedgerRows(legs);
      if (error) throw error;
      await linkExternalTransaction({ departmentId, externalRowId: pair.debit.id, expenseId: outId });
      await linkExternalTransaction({ departmentId, externalRowId: pair.credit.id, expenseId: inId });
      void logAuditFromBrowser({
        departmentId,
        userRole: membership.role,
        action: "transfer.recorded",
        resourceType: "expense",
        resourceId: inId,
        resourceLabel: `${fromAccount.name} → ${toAccount.name}`,
        afterData: { amount_cents: cents, transfer_group_id: groupId },
        metadata: { source: "bank_pair", outId, inId },
      });
      showSuccessMessage("Recorded as an internal transfer. It changes balances only — never income or spending.");
      await refresh();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not record this transfer.");
    } finally {
      setBusyId(null);
    }
  }

  function recordMoneyIn(credit: BankActivityRow, kind: string) {
    const account = credit.external_account_id ? accountsById.get(credit.external_account_id) : undefined;
    const prefill = bankCreditPrefill(credit, account);
    onRecordMoneyIn({
      mode: kind === "transfer" ? "transfer" : "money_in",
      date: prefill.date,
      payer: "",
      amountCents: prefill.amountCents,
      depositAccount: prefill.depositAccount,
      memo: prefill.memo,
      bank: prefill.bank,
    });
  }

  if (!credits.length) return null;
  const visible = expanded ? credits : credits.slice(0, COLLAPSED_COUNT);

  return (
    <section className="card fb-recon-deposits" aria-labelledby="fb-recon-deposits-title">
      <div className="section-heading">
        <h2 id="fb-recon-deposits-title">Bank deposits to review</h2>
        <p className="muted">
          Money that arrived in a linked account but is not recorded yet. Matching keeps every dollar counted once.
        </p>
      </div>
      <ul className="fb-recon-deposit-list">
        {visible.map(({ credit, transfer, best, kind }) => {
          const cents = Math.abs(bankSignedCents(credit) ?? 0);
          const account = credit.external_account_id ? accountsById.get(credit.external_account_id) : undefined;
          const otherAccount = transfer?.debit.external_account_id
            ? accountsById.get(transfer.debit.external_account_id)
            : undefined;
          const busy = busyId === credit.id;
          return (
            <li key={credit.id} className="fb-recon-deposit">
              <div className="fb-recon-deposit-main">
                <div className="fb-recon-deposit-text">
                  <strong>{credit.description || "Bank deposit"}</strong>
                  <span className="muted">
                    {formatDate(credit.posted_date)}
                    {account ? ` · ${account.name}` : ""}
                    {credit.pending ? " · Pending" : ""}
                  </span>
                </div>
                <span className="fb-recon-deposit-amount">+{formatUsd(cents)}</span>
              </div>
              {transfer ? (
                <div className="fb-recon-deposit-suggestion">
                  <span>
                    <strong>Possible internal transfer</strong>
                    {otherAccount ? ` from ${otherAccount.name}` : ""} · same amount left on {formatDate(transfer.debit.posted_date)}
                  </span>
                  <button type="button" className="fb-primary-btn" disabled={busy} onClick={() => void confirmTransfer(transfer)}>
                    Confirm transfer
                  </button>
                </div>
              ) : best ? (
                <div className="fb-recon-deposit-suggestion">
                  <span>
                    <strong>Possible bank match</strong> · {best.record.payee || "Money In"} ·{" "}
                    {formatDate(best.record.transaction_date)} · {best.reasons.slice(0, 3).join(", ")}
                  </span>
                  <button type="button" className="fb-primary-btn" disabled={busy} onClick={() => void confirmMatch(credit, best)}>
                    Match
                  </button>
                </div>
              ) : null}
              <div className="fb-recon-deposit-actions">
                <button type="button" className="link-button" disabled={busy} onClick={() => recordMoneyIn(credit, kind)}>
                  {kind === "transfer" ? "Record as transfer" : "Record money in"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {credits.length > COLLAPSED_COUNT ? (
        <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${credits.length}`}
        </button>
      ) : null}
    </section>
  );
}
