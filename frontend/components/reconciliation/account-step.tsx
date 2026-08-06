/**
 * Step 1 — choose which Hallix account the statement belongs to.
 *
 * The last reconciled date and ending balance are shown for each account
 * because they are what tells a treasurer which month to reach for next.
 */

"use client";

import { formatCents } from "../../lib/reconciliation/money";
import { formatDisplayDate } from "../../lib/reconciliation/dates";
import type { BankAccount } from "../../lib/types";

export function AccountStep({
  accounts,
  selectedId,
  onSelect,
  onContinue,
  starting,
}: {
  accounts: BankAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onContinue: () => void;
  starting: boolean;
}) {
  if (!accounts.length) {
    return (
      <div className="fb-stmt-step-body">
        <div className="fb-stmt-empty">
          <h3>No bank accounts yet</h3>
          <p>
            Add the bank account this statement belongs to in Settings, then come back to reconcile
            it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fb-stmt-step-body">
      <div className="fb-stmt-intro">
        <h2>Which account is this statement for?</h2>
        <p>Pick the Hallix account that matches the account number printed on the statement.</p>
      </div>

      <ul className="fb-stmt-account-list">
        {accounts.map((account) => {
          const selected = account.id === selectedId;
          const lastBalance =
            account.last_reconciled_ending_balance == null
              ? null
              : formatCents(Math.round(Number(account.last_reconciled_ending_balance) * 100));

          return (
            <li key={account.id}>
              <button
                type="button"
                className={`fb-stmt-account${selected ? " fb-stmt-account--selected" : ""}`}
                onClick={() => onSelect(account.id)}
                aria-pressed={selected}
              >
                <span className="fb-stmt-account-head">
                  <span className="fb-stmt-account-name">{account.name}</span>
                  {account.account_mask ? (
                    <span className="fb-stmt-account-mask">••••{account.account_mask}</span>
                  ) : null}
                </span>
                <span className="fb-stmt-account-meta">
                  {[account.institution_name, formatAccountType(account.account_type)]
                    .filter(Boolean)
                    .join(" · ") || "No bank name saved"}
                </span>
                <span className="fb-stmt-account-recon">
                  {account.last_reconciled_statement_end_date ? (
                    <>
                      Last reconciled through{" "}
                      <strong>{formatDisplayDate(account.last_reconciled_statement_end_date)}</strong>
                      {lastBalance ? <> · ending balance {lastBalance}</> : null}
                    </>
                  ) : (
                    "Not reconciled yet"
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="fb-stmt-actions">
        <button
          type="button"
          className="fb-primary-btn"
          disabled={!selectedId || starting}
          onClick={onContinue}
        >
          {starting ? "Starting…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

function formatAccountType(type: string | null | undefined): string | null {
  if (!type?.trim()) return null;
  return type
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
