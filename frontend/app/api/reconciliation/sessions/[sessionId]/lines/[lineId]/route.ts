/**
 * Treasurer decisions on a single statement line.
 *
 * Every action writes the decision, then re-runs pass 2 so the one-to-one
 * invariant, the summary counts and the balance status stay consistent. Manual
 * decisions survive that re-run because they are replayed as locked lines.
 */

import type { NextRequest } from "next/server";

import { normalizeStatementDate } from "../../../../../../../lib/reconciliation/dates";
import { parseCents } from "../../../../../../../lib/reconciliation/money";
import {
  fail,
  failFromAuth,
  logReconciliationError,
  ok,
  parseJsonBody,
  patchLineBodySchema,
  UNEXPECTED_ERROR,
  type LineCorrectionInput,
} from "../../../../../../../lib/reconciliation/server/api";
import {
  authorizeDepartmentRequest,
  isAuthFailure,
  isUuid,
  requireDepartmentBankAccount,
} from "../../../../../../../lib/reconciliation/server/auth";
import {
  loadSession,
  loadStatementLine,
  recordAuditEvent,
  ReconciliationDataError,
  updateStatementLine,
  type AuditEventType,
} from "../../../../../../../lib/reconciliation/server/data-access";
import {
  runConsolidation,
  type LineCorrection,
} from "../../../../../../../lib/reconciliation/server/consolidation-service";
import { loadSessionView } from "../../../../../../../lib/reconciliation/server/load-session-view";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string; lineId: string }> };

const AUDIT_EVENT_BY_ACTION = {
  match: "line_manually_matched",
  unmatch: "line_unmatched",
  not_applicable: "line_marked_not_applicable",
  correct: "line_manually_corrected",
  reset: "line_reset",
} as const satisfies Record<string, AuditEventType>;

export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  const { sessionId, lineId } = await routeContext.params;
  if (!isUuid(sessionId) || !isUuid(lineId)) {
    return fail(400, "That reconciliation link is not valid.");
  }

  const body = await parseJsonBody(request, patchLineBodySchema);
  if (isAuthFailure(body)) return failFromAuth(body);

  const context = await authorizeDepartmentRequest(request, body.departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  try {
    const session = await loadSession(context.supabase, sessionId, context.departmentId);
    if (session.status === "confirmed") {
      return fail(409, "This statement is already reconciled and can no longer be changed.");
    }

    const line = await loadStatementLine(context.supabase, lineId, context.departmentId);
    if (line.session_id !== sessionId) {
      return fail(404, "That statement line was not found.");
    }

    let correction: Record<string, LineCorrection> | undefined;

    switch (body.action) {
      case "match": {
        if (!body.expenseId) {
          return fail(400, "Choose the Hallix transaction this statement line belongs to.");
        }
        await updateStatementLine(context.supabase, lineId, context.departmentId, {
          match_status: "manually_matched",
          matched_expense_id: body.expenseId,
          match_score: null,
          match_reasons: [
            { code: "manual_selection", label: "You matched this line by hand.", points: 0 },
          ],
          manually_corrected: true,
        });
        break;
      }
      case "unmatch": {
        await updateStatementLine(context.supabase, lineId, context.departmentId, {
          match_status: "unmatched",
          matched_expense_id: null,
          match_score: null,
          match_reasons: [],
          manually_corrected: true,
        });
        break;
      }
      case "not_applicable": {
        await updateStatementLine(context.supabase, lineId, context.departmentId, {
          match_status: "not_applicable",
          matched_expense_id: null,
          match_score: null,
          match_reasons: [
            {
              code: "manual_selection",
              label: "You marked this line as not applicable.",
              points: 0,
            },
          ],
          manually_corrected: true,
        });
        break;
      }
      case "correct": {
        if (!body.correction) {
          return fail(400, "Enter the corrected values for this statement line.");
        }
        const patch = toLineCorrection(body.correction);
        if (!patch) {
          return fail(400, "Enter at least one corrected value for this statement line.");
        }
        correction = { [line.fingerprint]: patch };
        break;
      }
      case "reset": {
        await updateStatementLine(context.supabase, lineId, context.departmentId, {
          manually_corrected: false,
        });
        // A reset also drops any stored value correction for this line.
        correction = { [line.fingerprint]: {} };
        break;
      }
    }

    const bankAccount = session.bank_account_id
      ? await requireDepartmentBankAccount(context, session.bank_account_id)
      : null;
    if (bankAccount && isAuthFailure(bankAccount)) return failFromAuth(bankAccount);

    const outcome = await runConsolidation({
      supabase: context.supabase,
      session,
      bankAccount: bankAccount ?? null,
      lineCorrections: correction,
    });

    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId,
      eventType: AUDIT_EVENT_BY_ACTION[body.action],
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: {
        fingerprint: line.fingerprint,
        page_number: line.page_number,
        row_number: line.row_number,
        matched_expense_id: body.action === "match" ? body.expenseId : null,
        // Field names only: the values are statement content and stay out of logs.
        corrected_fields: correction ? Object.keys(correction[line.fingerprint] ?? {}) : [],
      },
    });

    return ok({
      view: await loadSessionView(context.supabase, sessionId, context.departmentId, {
        session: outcome.session,
        ledgerRows: outcome.ledgerRows,
      }),
    });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    logReconciliationError("update statement line", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}

/** Keep only the fields the treasurer actually filled in. */
function toLineCorrection(input: LineCorrectionInput): LineCorrection | null {
  const patch: LineCorrection = {};

  if (input.postedDate !== undefined) {
    const normalized = normalizeStatementDate(input.postedDate);
    if (input.postedDate && !normalized) return null;
    patch.postedDate = normalized;
  }
  if (input.originalDescription !== undefined) {
    patch.originalDescription = input.originalDescription?.trim() || null;
  }
  if (input.signedAmount !== undefined) {
    patch.signedAmountCents = parseCents(input.signedAmount);
  }
  if (input.checkNumber !== undefined) patch.checkNumber = input.checkNumber;
  if (input.referenceNumber !== undefined) patch.referenceNumber = input.referenceNumber;

  return Object.keys(patch).length ? patch : null;
}
