/**
 * Translations for the failures `confirm_statement_reconciliation` can raise.
 *
 * The database function raises bare codes rather than sentences so the wording a
 * treasurer reads is decided here, and so raw SQL text never reaches the browser.
 * Every one of these means the transaction rolled back and nothing was changed.
 */

export type ConfirmFailureCode =
  | "RECONCILIATION_SESSION_NOT_FOUND"
  | "RECONCILIATION_SESSION_ABANDONED"
  | "RECONCILIATION_REQUIRES_BALANCED_STATEMENT"
  | "RECONCILIATION_EXPENSE_ALREADY_RECONCILED"
  | "RECONCILIATION_EXPENSE_NOT_IN_DEPARTMENT";

export const CONFIRM_FAILURES: Record<
  ConfirmFailureCode,
  { status: number; message: string }
> = {
  RECONCILIATION_SESSION_NOT_FOUND: {
    status: 404,
    message: "That reconciliation could not be found.",
  },
  RECONCILIATION_SESSION_ABANDONED: {
    status: 409,
    message: "This reconciliation was discarded. Start a new one to reconcile this statement.",
  },
  RECONCILIATION_REQUIRES_BALANCED_STATEMENT: {
    status: 400,
    message:
      "This statement does not balance yet. Fix the difference, or explain in at least a sentence why you are reconciling anyway.",
  },
  RECONCILIATION_EXPENSE_ALREADY_RECONCILED: {
    status: 409,
    message:
      "One of these transactions was reconciled on another statement while you were reviewing. Nothing was changed — reopen the review to see the current matches.",
  },
  RECONCILIATION_EXPENSE_NOT_IN_DEPARTMENT: {
    status: 403,
    message: "One of these transactions does not belong to this department. Nothing was changed.",
  },
};

/** Minimum length of an override explanation, mirrored in the database function. */
export const MIN_OVERRIDE_REASON_LENGTH = 10;

export function mapConfirmError(
  databaseMessage: string,
): { status: number; message: string } | null {
  for (const [code, mapped] of Object.entries(CONFIRM_FAILURES)) {
    if (databaseMessage.includes(code)) return mapped;
  }
  return null;
}
