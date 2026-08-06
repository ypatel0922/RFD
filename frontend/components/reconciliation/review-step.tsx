/**
 * Step 3 — review what Hallix read and decide what gets reconciled.
 *
 * Nothing on this screen is permanent. Every proposed match is a suggestion held
 * in the draft session until "Confirm and Reconcile" is pressed, so a treasurer
 * can close the tab, come back, and pick up where they left off.
 */

"use client";

import { useMemo, useState } from "react";

import { formatCents } from "../../lib/reconciliation/money";
import type {
  SessionView,
  SessionViewExpense,
  SessionViewLine,
} from "../../lib/reconciliation/client/api-client";
import {
  ConfidencePill,
  LedgerRowSummary,
  MatchReasonList,
  StatFigure,
  StatementLineSummary,
  ValidationBanner,
} from "./statement-parts";
import { CorrectLineForm, ExpensePicker, type CorrectionDraft, type LedgerOption } from "./line-actions";

type ReviewTab = "matched" | "review" | "statement_only" | "ledger_only";

export type LineActionHandler = (
  lineId: string,
  action: "match" | "unmatch" | "not_applicable" | "correct" | "reset",
  payload?: { expenseId?: string; correction?: CorrectionDraft },
) => void;

export function ReviewStep({
  view,
  busyLineId,
  onLineAction,
  onCreateTransaction,
  onBack,
  onConfirm,
  confirming,
  manualBalances,
  onManualBalancesChange,
  onRecheck,
  rechecking,
}: {
  view: SessionView;
  busyLineId: string | null;
  onLineAction: LineActionHandler;
  onCreateTransaction: (line: SessionViewLine) => void;
  onBack: () => void;
  onConfirm: (overrideReason: string | null) => void;
  confirming: boolean;
  manualBalances: { beginning: string; ending: string };
  onManualBalancesChange: (next: { beginning: string; ending: string }) => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const [tab, setTab] = useState<ReviewTab>("review");
  const [overrideReason, setOverrideReason] = useState("");

  const session = view.session;

  const groups = useMemo(() => groupLines(view.lines), [view.lines]);

  const ledgerOnly = useMemo(
    () =>
      view.ledgerOnlyExpenseIds
        .map((id) => view.expenses[id])
        .filter((expense): expense is SessionViewExpense => Boolean(expense)),
    [view.expenses, view.ledgerOnlyExpenseIds],
  );

  const ledgerOptions = useMemo<LedgerOption[]>(() => {
    const claimed = new Set(
      view.lines.map((line) => line.matchedExpenseId).filter((id): id is string => Boolean(id)),
    );
    return Object.values(view.expenses).map((expense) => ({
      ...expense,
      alreadyUsedHere: claimed.has(expense.id),
    }));
  }, [view.expenses, view.lines]);

  const willReconcile = groups.matched.length;
  const unresolved = groups.review.length + groups.statementOnly.length;
  const balanced = session.validationStatus === "balanced";
  const overrideValid = overrideReason.trim().length >= 10;

  const tabs: Array<{ id: ReviewTab; label: string; count: number }> = [
    { id: "matched", label: "Matched", count: groups.matched.length },
    { id: "review", label: "Needs review", count: groups.review.length },
    { id: "statement_only", label: "Missing from Hallix", count: groups.statementOnly.length },
    { id: "ledger_only", label: "Missing from statement", count: ledgerOnly.length },
  ];

  return (
    <div className="fb-stmt-step-body">
      <section className="fb-stmt-summary">
        <header className="fb-stmt-summary-head">
          <div>
            <p className="eyebrow">{session.bankAccountName || "Bank account"}</p>
            <h2>{session.statementPeriodLabel}</h2>
            <p className="fb-stmt-summary-sub">
              {[
                session.statementInstitution,
                session.statementAccountLastFour ? `••••${session.statementAccountLastFour}` : null,
                `${session.pageCount} ${session.pageCount === 1 ? "page" : "pages"} read`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </header>

        <div className="fb-stmt-figure-grid">
          <StatFigure label="Beginning balance" value={formatCents(session.beginningBalanceCents)} />
          <StatFigure label="Deposits in" value={formatCents(session.totalCreditsCents)} />
          <StatFigure label="Withdrawals out" value={formatCents(session.totalDebitsCents)} />
          <StatFigure label="Ending balance" value={formatCents(session.endingBalanceCents)} />
          <StatFigure
            label="Difference"
            value={formatCents(session.balanceDifferenceCents ?? 0)}
            tone={balanced ? "good" : "bad"}
          />
          <StatFigure label="Statement transactions" value={String(view.lines.length)} />
        </div>
      </section>

      <ValidationBanner
        status={session.validationStatus}
        differenceCents={session.balanceDifferenceCents}
        findings={session.validationFindings}
      />

      {view.lines.length === 0 ? (
        <div className="fb-stmt-error" role="alert">
          No transactions were read from the statement pages. Go back and add the activity pages that
          list deposits and withdrawals, or retake any page that shows 0 transactions. Matching
          cannot run until transactions are read.
        </div>
      ) : null}

      {session.consolidationWarnings.length ? (
        <ul className="fb-stmt-warnings">
          {session.consolidationWarnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}

      <ManualBalancePanel
        values={manualBalances}
        onChange={onManualBalancesChange}
        onRecheck={onRecheck}
        rechecking={rechecking}
      />

      <nav className="fb-stmt-tabs" aria-label="Reconciliation results">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`fb-stmt-tab${tab === entry.id ? " fb-stmt-tab--active" : ""}`}
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
          >
            {entry.label}
            <span className="fb-stmt-tab-count">{entry.count}</span>
          </button>
        ))}
      </nav>

      <div className="fb-stmt-tab-panel">
        {tab === "matched" ? (
          <MatchedPanel
            lines={groups.matched}
            expenses={view.expenses}
            busyLineId={busyLineId}
            onLineAction={onLineAction}
            ledgerOptions={ledgerOptions}
          />
        ) : null}

        {tab === "review" ? (
          <NeedsReviewPanel
            lines={groups.review}
            expenses={view.expenses}
            ledgerOptions={ledgerOptions}
            busyLineId={busyLineId}
            onLineAction={onLineAction}
            onCreateTransaction={onCreateTransaction}
          />
        ) : null}

        {tab === "statement_only" ? (
          <StatementOnlyPanel
            lines={groups.statementOnly}
            totalStatementLines={view.lines.length}
            ledgerOptions={ledgerOptions}
            busyLineId={busyLineId}
            onLineAction={onLineAction}
            onCreateTransaction={onCreateTransaction}
          />
        ) : null}

        {tab === "ledger_only" ? <LedgerOnlyPanel expenses={ledgerOnly} /> : null}
      </div>

      <section className="fb-stmt-confirm">
        <h3>Ready to reconcile?</h3>
        <ul className="fb-stmt-confirm-facts">
          <li>
            <strong>{willReconcile}</strong>{" "}
            {willReconcile === 1 ? "transaction" : "transactions"} will be marked reconciled.
          </li>
          <li>
            <strong>{unresolved}</strong> {unresolved === 1 ? "item is" : "items are"} still
            unresolved. They will be left alone.
          </li>
          <li>
            The statement{" "}
            <strong>{balanced ? "balances" : "does not balance"}</strong>
            {!balanced && session.balanceDifferenceCents
              ? ` (off by ${formatCents(Math.abs(session.balanceDifferenceCents))})`
              : ""}
            .
          </li>
        </ul>

        {!balanced ? (
          <label className="fb-stmt-override">
            <span>
              This statement does not balance. To reconcile it anyway, explain why. Your explanation
              is saved to the audit log.
            </span>
            <textarea
              value={overrideReason}
              rows={3}
              placeholder="For example: the bank omitted a corrected fee that posts next month."
              onChange={(event) => setOverrideReason(event.target.value)}
            />
          </label>
        ) : null}

        <div className="fb-stmt-actions">
          <button type="button" className="fb-secondary-btn" onClick={onBack} disabled={confirming}>
            Back to pages
          </button>
          <button
            type="button"
            className="fb-primary-btn"
            disabled={confirming || (!balanced && !overrideValid)}
            onClick={() => onConfirm(balanced ? null : overrideReason.trim())}
          >
            {confirming ? "Reconciling…" : "Confirm and Reconcile"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ManualBalancePanel({
  values,
  onChange,
  onRecheck,
  rechecking,
}: {
  values: { beginning: string; ending: string };
  onChange: (next: { beginning: string; ending: string }) => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <details className="fb-stmt-manual">
      <summary>Correct the statement balances</summary>
      <p className="fb-stmt-manual-hint">
        If Hallix could not read a balance, or read it wrong, type what the statement shows and
        check again.
      </p>
      <div className="fb-stmt-manual-grid">
        <label>
          <span>Beginning balance</span>
          <input
            type="text"
            inputMode="decimal"
            value={values.beginning}
            placeholder="0.00"
            onChange={(event) => onChange({ ...values, beginning: event.target.value })}
          />
        </label>
        <label>
          <span>Ending balance</span>
          <input
            type="text"
            inputMode="decimal"
            value={values.ending}
            placeholder="0.00"
            onChange={(event) => onChange({ ...values, ending: event.target.value })}
          />
        </label>
        <button type="button" className="fb-secondary-btn" onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Check again"}
        </button>
      </div>
    </details>
  );
}

function MatchedPanel({
  lines,
  expenses,
  ledgerOptions,
  busyLineId,
  onLineAction,
}: {
  lines: SessionViewLine[];
  expenses: Record<string, SessionViewExpense>;
  ledgerOptions: LedgerOption[];
  busyLineId: string | null;
  onLineAction: LineActionHandler;
}) {
  const [changing, setChanging] = useState<string | null>(null);

  if (!lines.length) {
    return <p className="fb-stmt-empty-inline">Nothing is matched yet.</p>;
  }

  return (
    <ul className="fb-stmt-match-list">
      {lines.map((line) => (
        <li key={line.id} className="fb-stmt-match">
          <div className="fb-stmt-match-pair">
            <div className="fb-stmt-match-side">
              <p className="fb-stmt-match-side-label">On the statement</p>
              <StatementLineSummary line={line} />
            </div>
            <div className="fb-stmt-match-side">
              <p className="fb-stmt-match-side-label">In Hallix</p>
              <LedgerRowSummary expense={expenses[line.matchedExpenseId || ""]} />
            </div>
          </div>

          <div className="fb-stmt-match-foot">
            <ConfidencePill score={line.matchScore} status={line.matchStatus} />
            <MatchReasonList reasons={line.matchReasons} />
          </div>

          {changing === line.id ? (
            <ExpensePicker
              options={ledgerOptions}
              suggestedIds={line.candidateExpenseIds}
              busy={busyLineId === line.id}
              onChoose={(expenseId) => {
                setChanging(null);
                onLineAction(line.id, "match", { expenseId });
              }}
              onCancel={() => setChanging(null)}
            />
          ) : (
            <div className="fb-stmt-match-actions">
              <button type="button" className="fb-stmt-link-btn" onClick={() => setChanging(line.id)}>
                Change match
              </button>
              <button
                type="button"
                className="fb-stmt-link-btn"
                disabled={busyLineId === line.id}
                onClick={() => onLineAction(line.id, "unmatch")}
              >
                Unmatch
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function NeedsReviewPanel({
  lines,
  expenses,
  ledgerOptions,
  busyLineId,
  onLineAction,
  onCreateTransaction,
}: {
  lines: SessionViewLine[];
  expenses: Record<string, SessionViewExpense>;
  ledgerOptions: LedgerOption[];
  busyLineId: string | null;
  onLineAction: LineActionHandler;
  onCreateTransaction: (line: SessionViewLine) => void;
}) {
  if (!lines.length) {
    return <p className="fb-stmt-empty-inline">Nothing needs review.</p>;
  }

  return (
    <ul className="fb-stmt-match-list">
      {lines.map((line) => (
        <UnresolvedLine
          key={line.id}
          line={line}
          expenses={expenses}
          ledgerOptions={ledgerOptions}
          busy={busyLineId === line.id}
          onLineAction={onLineAction}
          onCreateTransaction={onCreateTransaction}
        />
      ))}
    </ul>
  );
}

function StatementOnlyPanel({
  lines,
  totalStatementLines,
  ledgerOptions,
  busyLineId,
  onLineAction,
  onCreateTransaction,
}: {
  lines: SessionViewLine[];
  totalStatementLines: number;
  ledgerOptions: LedgerOption[];
  busyLineId: string | null;
  onLineAction: LineActionHandler;
  onCreateTransaction: (line: SessionViewLine) => void;
}) {
  if (!lines.length) {
    return (
      <p className="fb-stmt-empty-inline">
        {totalStatementLines === 0
          ? "No transactions were read from the statement. Go back and add the activity pages, or retake any page that shows 0 transactions."
          : "Every transaction Hallix read from the statement was matched or marked for review."}
      </p>
    );
  }

  return (
    <>
      <p className="fb-stmt-panel-note">
        These are on the bank statement but not in Hallix. They may be an unrecorded expense, a bank
        fee, interest, a deposit, a transfer — or something that should not be there at all.
      </p>
      <ul className="fb-stmt-match-list">
        {lines.map((line) => (
          <UnresolvedLine
            key={line.id}
            line={line}
            expenses={{}}
            ledgerOptions={ledgerOptions}
            busy={busyLineId === line.id}
            onLineAction={onLineAction}
            onCreateTransaction={onCreateTransaction}
          />
        ))}
      </ul>
    </>
  );
}

function UnresolvedLine({
  line,
  expenses,
  ledgerOptions,
  busy,
  onLineAction,
  onCreateTransaction,
}: {
  line: SessionViewLine;
  expenses: Record<string, SessionViewExpense>;
  ledgerOptions: LedgerOption[];
  busy: boolean;
  onLineAction: LineActionHandler;
  onCreateTransaction: (line: SessionViewLine) => void;
}) {
  const [mode, setMode] = useState<"idle" | "pick" | "correct">("idle");
  const candidates = line.candidateExpenseIds
    .map((id) => expenses[id])
    .filter((expense): expense is SessionViewExpense => Boolean(expense));

  return (
    <li className="fb-stmt-match fb-stmt-match--review">
      <div className="fb-stmt-match-side">
        <p className="fb-stmt-match-side-label">{statusLabel(line.matchStatus)}</p>
        <StatementLineSummary line={line} />
        {line.extractionWarning ? (
          <p className="fb-stmt-line-warning">{line.extractionWarning}</p>
        ) : null}
      </div>

      {candidates.length ? (
        <div className="fb-stmt-candidates">
          <p className="fb-stmt-match-side-label">Possible matches in Hallix</p>
          {candidates.map((candidate) => (
            <div key={candidate.id} className="fb-stmt-candidate">
              <LedgerRowSummary expense={candidate} />
              <button
                type="button"
                className="fb-stmt-link-btn"
                disabled={busy}
                onClick={() => onLineAction(line.id, "match", { expenseId: candidate.id })}
              >
                This one
              </button>
            </div>
          ))}
          <MatchReasonList reasons={line.matchReasons} />
        </div>
      ) : null}

      {mode === "pick" ? (
        <ExpensePicker
          options={ledgerOptions}
          suggestedIds={line.candidateExpenseIds}
          busy={busy}
          onChoose={(expenseId) => {
            setMode("idle");
            onLineAction(line.id, "match", { expenseId });
          }}
          onCancel={() => setMode("idle")}
        />
      ) : mode === "correct" ? (
        <CorrectLineForm
          line={line}
          busy={busy}
          onSave={(correction) => {
            setMode("idle");
            onLineAction(line.id, "correct", { correction });
          }}
          onCancel={() => setMode("idle")}
        />
      ) : (
        <div className="fb-stmt-match-actions">
          <button type="button" className="fb-stmt-link-btn" onClick={() => setMode("pick")}>
            Search transactions
          </button>
          <button
            type="button"
            className="fb-stmt-link-btn"
            onClick={() => onCreateTransaction(line)}
          >
            Add to Hallix
          </button>
          <button type="button" className="fb-stmt-link-btn" onClick={() => setMode("correct")}>
            Fix what Hallix read
          </button>
          <button
            type="button"
            className="fb-stmt-link-btn"
            disabled={busy}
            onClick={() => onLineAction(line.id, "not_applicable")}
          >
            Not applicable
          </button>
          {line.manuallyCorrected ? (
            <button
              type="button"
              className="fb-stmt-link-btn"
              disabled={busy}
              onClick={() => onLineAction(line.id, "reset")}
            >
              Undo my change
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function LedgerOnlyPanel({ expenses }: { expenses: SessionViewExpense[] }) {
  if (!expenses.length) {
    return (
      <p className="fb-stmt-empty-inline">
        Every Hallix transaction in this period appears on the statement.
      </p>
    );
  }

  return (
    <>
      <p className="fb-stmt-panel-note">
        These are recorded in Hallix within the statement period but were not found on the
        statement. A check may still be outstanding, or the transaction may have the wrong account,
        the wrong amount, or the wrong date. Nothing here will be reconciled.
      </p>
      <ul className="fb-stmt-simple-list">
        {expenses.map((expense) => (
          <li key={expense.id}>
            <LedgerRowSummary expense={expense} />
          </li>
        ))}
      </ul>
    </>
  );
}

const STATUS_LABELS: Record<string, string> = {
  possible_match: "Possible match — please check",
  ambiguous_duplicate: "More than one transaction could match",
  already_reconciled: "The best match was already reconciled",
  outside_period: "Dated outside the statement period",
  unmatched: "Not found in Hallix",
  not_applicable: "Marked not applicable",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || "Needs review";
}

function groupLines(lines: SessionViewLine[]) {
  const matched: SessionViewLine[] = [];
  const review: SessionViewLine[] = [];
  const statementOnly: SessionViewLine[] = [];

  for (const line of lines) {
    switch (line.matchStatus) {
      case "auto_matched":
      case "manually_matched":
        matched.push(line);
        break;
      case "possible_match":
      case "ambiguous_duplicate":
      case "already_reconciled":
      case "outside_period":
        review.push(line);
        break;
      case "not_applicable":
        break;
      default:
        statementOnly.push(line);
    }
  }

  return { matched, review, statementOnly };
}
