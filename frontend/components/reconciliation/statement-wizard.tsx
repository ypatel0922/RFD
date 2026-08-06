/**
 * Monthly statement reconciliation wizard.
 *
 * This component owns the session and the step the treasurer is on, and nothing
 * else: extraction, consolidation, validation and matching all happen on the
 * server, and this file only sends requests and renders what comes back.
 *
 * Statement photographs are never uploaded to Hallix storage. They are prepared
 * in the browser, posted to an authenticated endpoint that holds them in memory
 * while the vision provider reads them, and then discarded. What is saved is the
 * structured result: dates, descriptions, amounts, and the audit trail.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import {
  abandonSession,
  confirmReconciliation,
  consolidateSession,
  getSession,
  patchLine,
  ReconciliationApiError,
  startSession,
  type SessionView,
  type SessionViewLine,
} from "../../lib/reconciliation/client/api-client";
import { useStatementPages } from "../../lib/reconciliation/client/use-statement-pages";
import type { BankAccount, DepartmentMembership } from "../../lib/types";
import { AccountStep } from "./account-step";
import { PagesStep } from "./pages-step";
import { ReviewStep, type LineActionHandler } from "./review-step";
import { WizardStepper, type WizardStep } from "./statement-parts";

/** Statement data used to prefill the "add this to Hallix" form. */
export type PrefilledTransaction = {
  date: string | null;
  description: string;
  amountDollars: number | null;
  isDeposit: boolean;
  checkNumber: string | null;
  bankAccountId: string | null;
  bankAccountName: string | null;
};

export function StatementWizard({
  bankAccounts,
  membership,
  accessToken,
  initialBankAccountId,
  onClose,
  onCreateTransaction,
  onReconciled,
}: {
  bankAccounts: BankAccount[];
  membership: DepartmentMembership;
  accessToken: string;
  initialBankAccountId?: string | null;
  onClose: () => void;
  onCreateTransaction: (prefill: PrefilledTransaction) => void;
  onReconciled: () => Promise<void> | void;
}) {
  const departmentId = membership.department_id;

  const [step, setStep] = useState<WizardStep>("account");
  const [accountId, setAccountId] = useState<string | null>(
    initialBankAccountId || bankAccounts.find((account) => account.is_default)?.id || null,
  );
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [manualBalances, setManualBalances] = useState({ beginning: "", ending: "" });
  const [confirmation, setConfirmation] = useState<{ count: number } | null>(null);

  const sessionId = view?.session.id ?? null;

  const pages = useStatementPages({ sessionId, departmentId, token: accessToken });

  function report(unknownError: unknown, fallback: string) {
    setError(unknownError instanceof ReconciliationApiError ? unknownError.message : fallback);
  }

  async function handleStart() {
    if (!accountId) return;
    setStarting(true);
    setError(null);
    try {
      const result = await startSession({
        token: accessToken,
        departmentId,
        bankAccountId: accountId,
      });
      setView(result.view);
      setStep("pages");
    } catch (caught) {
      report(caught, "Hallix could not start this reconciliation. Please try again.");
    } finally {
      setStarting(false);
    }
  }

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await getSession({ token: accessToken, sessionId, departmentId });
      setView(result.view);
    } catch {
      // A failed background refresh is not worth interrupting the treasurer; the
      // next explicit action will surface any real problem.
    }
  }, [accessToken, departmentId, sessionId]);

  async function handleReview() {
    if (!sessionId) return;
    setReviewing(true);
    setError(null);
    try {
      const result = await consolidateSession({ token: accessToken, sessionId, departmentId });
      setView(result.view);
      setStep("review");
    } catch (caught) {
      report(caught, "Hallix could not put the statement together. Please try again.");
    } finally {
      setReviewing(false);
    }
  }

  async function handleRecheck() {
    if (!sessionId) return;
    setRechecking(true);
    setError(null);
    try {
      const result = await consolidateSession({
        token: accessToken,
        sessionId,
        departmentId,
        manualBeginningBalance: manualBalances.beginning.trim() || null,
        manualEndingBalance: manualBalances.ending.trim() || null,
      });
      setView(result.view);
    } catch (caught) {
      report(caught, "Hallix could not check the balances. Please try again.");
    } finally {
      setRechecking(false);
    }
  }

  const handleLineAction: LineActionHandler = async (lineId, action, payload) => {
    if (!sessionId) return;
    setBusyLineId(lineId);
    setError(null);
    try {
      const result = await patchLine({
        token: accessToken,
        sessionId,
        lineId,
        departmentId,
        action,
        expenseId: payload?.expenseId,
        correction: payload?.correction
          ? {
              postedDate: payload.correction.postedDate || null,
              originalDescription: payload.correction.originalDescription || null,
              signedAmount: payload.correction.signedAmount || null,
              checkNumber: payload.correction.checkNumber || null,
            }
          : undefined,
      });
      setView(result.view);
    } catch (caught) {
      report(caught, "That change could not be saved. Please try again.");
    } finally {
      setBusyLineId(null);
    }
  };

  async function handleConfirm(overrideReason: string | null) {
    if (!view || !sessionId) return;
    const lineIds = view.lines
      .filter((line) => line.matchStatus === "auto_matched" || line.matchStatus === "manually_matched")
      .map((line) => line.id);

    setConfirming(true);
    setError(null);
    try {
      const result = await confirmReconciliation({
        token: accessToken,
        sessionId,
        departmentId,
        lineIds,
        overrideReason,
      });
      setView(result.view);
      setConfirmation({ count: result.confirmedCount });
      await onReconciled();
    } catch (caught) {
      report(caught, "Nothing was reconciled. Please try again.");
      // The failure may have been a race with another reconciliation, so pull
      // the current state rather than leaving a stale screen on display.
      await refresh();
    } finally {
      setConfirming(false);
    }
  }

  function handleCreateTransaction(line: SessionViewLine) {
    const cents = line.signedAmountCents ?? 0;
    onCreateTransaction({
      date: line.postedDate,
      description: line.originalDescription || "",
      amountDollars: line.signedAmountCents == null ? null : Math.abs(cents) / 100,
      isDeposit: cents > 0,
      checkNumber: line.checkNumber,
      bankAccountId: view?.session.bankAccountId ?? null,
      bankAccountName: view?.session.bankAccountName ?? null,
    });
  }

  async function handleClose() {
    // A draft with no readable pages is noise; drop it rather than leaving it to
    // expire. A draft with pages is kept so the treasurer can resume.
    if (sessionId && view?.session.status !== "confirmed" && pages.readableCount === 0) {
      try {
        await abandonSession({ token: accessToken, sessionId, departmentId });
      } catch {
        // Cleanup is best effort; the retention job removes it either way.
      }
    }
    onClose();
  }

  // Warn before a refresh loses unsent pages. Nothing is reconciled by leaving,
  // but re-photographing pages is the one genuinely annoying loss.
  useEffect(() => {
    if (!pages.pages.length || confirmation) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [confirmation, pages.pages.length]);

  if (confirmation && view) {
    return (
      <SuccessSummary
        view={view}
        confirmedCount={confirmation.count}
        onDone={onClose}
      />
    );
  }

  return (
    <div className="fb-stmt-wizard">
      <header className="fb-stmt-header">
        <button type="button" className="fb-back-link secondary-action" onClick={handleClose}>
          ← Back to Reconciliation
        </button>
        <h1 className="fb-dash-title">Reconcile Monthly Statement</h1>
        <p className="fb-dash-subtitle">
          Upload photos of every page of your monthly bank statement. Hallix will read the
          statement, compare it with your recorded transactions, and show you what matched or needs
          review.
        </p>
      </header>

      <WizardStepper current={step} />

      {error ? (
        <div className="fb-stmt-error" role="alert">
          {error}
        </div>
      ) : null}

      {step === "account" ? (
        <AccountStep
          accounts={bankAccounts}
          selectedId={accountId}
          onSelect={setAccountId}
          onContinue={handleStart}
          starting={starting}
        />
      ) : null}

      {step === "pages" ? (
        <PagesStep
          pages={pages.pages}
          addError={pages.addError}
          busy={pages.busy}
          readableCount={pages.readableCount}
          transactionLineCount={pages.transactionLineCount}
          problemCount={pages.problemCount}
          onAddFiles={(files) => void pages.addFiles(files)}
          onRetry={pages.retryPage}
          onRemove={pages.removePage}
          onMove={pages.movePage}
          onBack={() => setStep("account")}
          onReview={() => void handleReview()}
          reviewing={reviewing}
        />
      ) : null}

      {step === "review" && view ? (
        <ReviewStep
          view={view}
          busyLineId={busyLineId}
          onLineAction={handleLineAction}
          onCreateTransaction={handleCreateTransaction}
          onBack={() => setStep("pages")}
          onConfirm={(reason) => void handleConfirm(reason)}
          confirming={confirming}
          manualBalances={manualBalances}
          onManualBalancesChange={setManualBalances}
          onRecheck={() => void handleRecheck()}
          rechecking={rechecking}
        />
      ) : null}
    </div>
  );
}

function SuccessSummary({
  view,
  confirmedCount,
  onDone,
}: {
  view: SessionView;
  confirmedCount: number;
  onDone: () => void;
}) {
  const session = view.session;
  return (
    <div className="fb-stmt-wizard">
      <div className="fb-stmt-success">
        <span className="fb-stmt-success-mark" aria-hidden>
          ✓
        </span>
        <h1>Statement reconciled</h1>
        <p>
          {confirmedCount} {confirmedCount === 1 ? "transaction was" : "transactions were"} marked
          reconciled for {session.bankAccountName || "this account"}.
        </p>
        <dl className="fb-stmt-success-facts">
          <div>
            <dt>Statement period</dt>
            <dd>{session.statementPeriodLabel}</dd>
          </div>
          <div>
            <dt>Ending balance</dt>
            <dd>{formatBalance(session.endingBalanceCents)}</dd>
          </div>
          <div>
            <dt>Still unresolved</dt>
            <dd>{session.needsReviewCount + session.statementOnlyCount}</dd>
          </div>
        </dl>
        {session.overrideReason ? (
          <p className="fb-stmt-success-override">
            Reconciled with an override: {session.overrideReason}
          </p>
        ) : null}
        <button type="button" className="fb-primary-btn" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function formatBalance(cents: number | null): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
