/**
 * Controls for resolving one statement line: pick a Hallix transaction, or fix a
 * value the model misread.
 *
 * The picker searches the whole unreconciled ledger rather than only the
 * suggested candidates, because the reason a line went unmatched is often that
 * the transaction was entered on the wrong date or account and so never became a
 * candidate in the first place.
 */

"use client";

import { useMemo, useState } from "react";

import { formatDisplayDate } from "../../lib/reconciliation/dates";
import { formatSignedCents } from "../../lib/reconciliation/money";
import type { SessionViewExpense, SessionViewLine } from "../../lib/reconciliation/client/api-client";

export type LedgerOption = SessionViewExpense & { alreadyUsedHere: boolean };

export function ExpensePicker({
  options,
  suggestedIds,
  busy,
  onChoose,
  onCancel,
}: {
  options: LedgerOption[];
  suggestedIds: string[];
  busy: boolean;
  onChoose: (expenseId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");

  const { suggested, others } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = options.filter((option) => {
      if (!needle) return true;
      return [option.vendor, option.description, option.category, option.paymentReference]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });

    const suggestedSet = new Set(suggestedIds);
    return {
      suggested: matches.filter((option) => suggestedSet.has(option.id)),
      others: matches.filter((option) => !suggestedSet.has(option.id)),
    };
  }, [options, query, suggestedIds]);

  return (
    <div className="fb-stmt-picker">
      <label className="fb-stmt-picker-search">
        <span className="fb-visually-hidden">Search transactions</span>
        <input
          type="search"
          value={query}
          placeholder="Search by vendor, description, or reference"
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>

      {suggested.length ? (
        <>
          <p className="fb-stmt-picker-heading">Suggested</p>
          <PickerOptions options={suggested} busy={busy} onChoose={onChoose} />
        </>
      ) : null}

      {others.length ? (
        <>
          <p className="fb-stmt-picker-heading">
            {suggested.length ? "Other transactions" : "Transactions"}
          </p>
          <PickerOptions options={others} busy={busy} onChoose={onChoose} />
        </>
      ) : null}

      {!suggested.length && !others.length ? (
        <p className="fb-stmt-empty-inline">
          No transactions match that search. Try a shorter search, or add this as a new transaction.
        </p>
      ) : null}

      <button type="button" className="fb-secondary-btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

function PickerOptions({
  options,
  busy,
  onChoose,
}: {
  options: LedgerOption[];
  busy: boolean;
  onChoose: (expenseId: string) => void;
}) {
  return (
    <ul className="fb-stmt-picker-list">
      {options.map((option) => (
        <li key={option.id}>
          <button
            type="button"
            className="fb-stmt-picker-option"
            disabled={busy || option.isAlreadyReconciled || option.alreadyUsedHere}
            onClick={() => onChoose(option.id)}
          >
            <span className="fb-stmt-picker-option-main">
              <span className="fb-stmt-picker-option-vendor">
                {option.vendor || option.description || "Untitled"}
              </span>
              <span className="fb-stmt-picker-option-meta">
                {formatDisplayDate(option.date)}
                {option.bankAccountName ? ` · ${option.bankAccountName}` : ""}
              </span>
            </span>
            <span className="fb-stmt-picker-option-amount">
              {formatSignedCents(option.signedAmountCents)}
              {option.isAlreadyReconciled ? (
                <span className="fb-stmt-picker-option-note">Already reconciled</span>
              ) : option.alreadyUsedHere ? (
                <span className="fb-stmt-picker-option-note">Matched to another line</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export type CorrectionDraft = {
  postedDate: string;
  originalDescription: string;
  signedAmount: string;
  checkNumber: string;
};

export function CorrectLineForm({
  line,
  busy,
  onSave,
  onCancel,
}: {
  line: SessionViewLine;
  busy: boolean;
  onSave: (draft: CorrectionDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CorrectionDraft>({
    postedDate: line.postedDate || "",
    originalDescription: line.originalDescription || "",
    signedAmount:
      line.signedAmountCents == null ? "" : (line.signedAmountCents / 100).toFixed(2),
    checkNumber: line.checkNumber || "",
  });

  return (
    <form
      className="fb-stmt-correct"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <p className="fb-stmt-correct-hint">
        Type what the statement actually shows. Use a negative amount for money leaving the account
        and a positive amount for a deposit.
      </p>

      <div className="fb-stmt-correct-grid">
        <label>
          <span>Date</span>
          <input
            type="date"
            value={draft.postedDate}
            onChange={(event) => setDraft({ ...draft, postedDate: event.target.value })}
          />
        </label>
        <label>
          <span>Amount</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.signedAmount}
            placeholder="-125.00"
            onChange={(event) => setDraft({ ...draft, signedAmount: event.target.value })}
          />
        </label>
        <label className="fb-stmt-correct-wide">
          <span>Description</span>
          <input
            type="text"
            value={draft.originalDescription}
            onChange={(event) => setDraft({ ...draft, originalDescription: event.target.value })}
          />
        </label>
        <label>
          <span>Check number</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft.checkNumber}
            onChange={(event) => setDraft({ ...draft, checkNumber: event.target.value })}
          />
        </label>
      </div>

      <div className="fb-stmt-correct-actions">
        <button type="button" className="fb-secondary-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="fb-primary-btn" disabled={busy}>
          {busy ? "Saving…" : "Save correction"}
        </button>
      </div>
    </form>
  );
}
