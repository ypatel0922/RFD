/**
 * Small presentational pieces shared by the statement wizard steps.
 *
 * These are deliberately dumb: no data fetching, no session state. Everything
 * they render comes from props so the steps stay easy to read.
 */

"use client";

import { formatCents, formatSignedCents, type Cents } from "../../lib/reconciliation/money";
import { formatDisplayDate } from "../../lib/reconciliation/dates";
import type { MatchReason, ValidationFinding, ValidationStatus } from "../../lib/reconciliation/types";
import type { SessionViewExpense, SessionViewLine } from "../../lib/reconciliation/client/api-client";

export const WIZARD_STEPS = ["account", "pages", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

const STEP_LABELS: Record<WizardStep, string> = {
  account: "Account",
  pages: "Statement pages",
  review: "Review",
};

export function WizardStepper({ current }: { current: WizardStep }) {
  const currentIndex = WIZARD_STEPS.indexOf(current);

  return (
    <ol className="fb-stmt-stepper" aria-label="Reconciliation steps">
      {WIZARD_STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <li key={step} className={`fb-stmt-step fb-stmt-step--${state}`}>
            <span className="fb-stmt-step-dot" aria-hidden>
              {state === "done" ? "✓" : index + 1}
            </span>
            <span className="fb-stmt-step-label">{STEP_LABELS[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function StatFigure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className={`fb-stmt-figure${tone ? ` fb-stmt-figure--${tone}` : ""}`}>
      <p className="fb-stmt-figure-label">{label}</p>
      <p className="fb-stmt-figure-value">{value}</p>
      {hint ? <p className="fb-stmt-figure-hint">{hint}</p> : null}
    </div>
  );
}

const VALIDATION_COPY: Record<ValidationStatus, { label: string; tone: string; blurb: string }> = {
  balanced: {
    label: "Statement balances",
    tone: "good",
    blurb:
      "The beginning balance plus deposits minus withdrawals equals the ending balance on the statement.",
  },
  out_of_balance: {
    label: "Statement does not balance",
    tone: "bad",
    blurb:
      "The transactions Hallix read do not add up to the ending balance. A page or a line is probably missing or misread.",
  },
  incomplete: {
    label: "Not enough information to check",
    tone: "warn",
    blurb:
      "Hallix could not find both balances on the statement. Add the missing page, or type the balances in below.",
  },
  not_validated: {
    label: "Not checked yet",
    tone: "warn",
    blurb: "Add your statement pages and Hallix will check the balances.",
  },
};

export function ValidationBanner({
  status,
  differenceCents,
  findings,
}: {
  status: ValidationStatus;
  differenceCents: Cents | null;
  findings: ValidationFinding[];
}) {
  const copy = VALIDATION_COPY[status];
  const offBy =
    status === "out_of_balance" && differenceCents != null && differenceCents !== 0
      ? `Off by ${formatCents(Math.abs(differenceCents))}.`
      : null;

  return (
    <section className={`fb-stmt-validation fb-stmt-validation--${copy.tone}`}>
      <div className="fb-stmt-validation-head">
        <h3>{copy.label}</h3>
        {offBy ? <span className="fb-stmt-validation-off">{offBy}</span> : null}
      </div>
      <p className="fb-stmt-validation-blurb">{copy.blurb}</p>
      {findings.length ? (
        <ul className="fb-stmt-findings">
          {findings.map((finding, index) => (
            <li key={`${finding.code}-${index}`} className={`fb-stmt-finding fb-stmt-finding--${finding.severity}`}>
              {finding.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MatchReasonList({ reasons }: { reasons: MatchReason[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="fb-stmt-reasons">
      {reasons.map((reason, index) => (
        <li key={`${reason.code}-${index}`}>{reason.label}</li>
      ))}
    </ul>
  );
}

export function ConfidencePill({ score, status }: { score: number | null; status: string }) {
  if (status === "manually_matched") {
    return <span className="fb-stmt-pill fb-stmt-pill--manual">Matched by you</span>;
  }
  if (score == null) return null;
  const percent = Math.round(score * 100);
  const tone = percent >= 80 ? "good" : percent >= 60 ? "warn" : "low";
  return <span className={`fb-stmt-pill fb-stmt-pill--${tone}`}>{percent}% confidence</span>;
}

/** One statement line, rendered the same way everywhere it appears. */
export function StatementLineSummary({ line }: { line: SessionViewLine }) {
  return (
    <div className="fb-stmt-line">
      <div className="fb-stmt-line-main">
        <span className="fb-stmt-line-date">{formatDisplayDate(line.postedDate)}</span>
        <span className="fb-stmt-line-desc">{line.originalDescription || "No description"}</span>
      </div>
      <div className="fb-stmt-line-meta">
        <span
          className={
            (line.signedAmountCents ?? 0) < 0 ? "fb-amount-expense" : "fb-amount-income"
          }
        >
          {formatSignedCents(line.signedAmountCents)}
        </span>
        <span className="fb-stmt-line-source">
          Page {line.pageNumber}, line {line.rowNumber}
          {line.checkNumber ? ` · Check ${line.checkNumber}` : ""}
        </span>
      </div>
    </div>
  );
}

export function LedgerRowSummary({ expense }: { expense: SessionViewExpense | undefined }) {
  if (!expense) {
    return <p className="fb-stmt-empty-inline">This transaction is no longer available.</p>;
  }
  return (
    <div className="fb-stmt-line">
      <div className="fb-stmt-line-main">
        <span className="fb-stmt-line-date">{formatDisplayDate(expense.date)}</span>
        <span className="fb-stmt-line-desc">{expense.vendor || expense.description || "Untitled"}</span>
      </div>
      <div className="fb-stmt-line-meta">
        <span
          className={(expense.signedAmountCents ?? 0) < 0 ? "fb-amount-expense" : "fb-amount-income"}
        >
          {formatSignedCents(expense.signedAmountCents)}
        </span>
        <span className="fb-stmt-line-source">
          {expense.bankAccountName || "No account"}
          {expense.category ? ` · ${expense.category}` : ""}
        </span>
      </div>
    </div>
  );
}
