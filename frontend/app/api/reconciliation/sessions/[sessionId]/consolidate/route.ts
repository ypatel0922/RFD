/**
 * POST /api/reconciliation/sessions/:sessionId/consolidate
 *
 * Runs pass 2 once every page has been read: assemble the pages into one
 * statement, validate the balances, and propose matches. Safe to call again --
 * it rebuilds from the stored page extractions, so the treasurer can add a
 * missing page or type in a balance and re-run without redoing the photos.
 */

import { NextRequest } from "next/server";

import { normalizeStatementDate } from "../../../../../../lib/reconciliation/dates";
import {
  consolidateBodySchema,
  fail,
  failFromAuth,
  logReconciliationError,
  ok,
  parseJsonBody,
  UNEXPECTED_ERROR,
} from "../../../../../../lib/reconciliation/server/api";
import {
  authorizeDepartmentRequest,
  isAuthFailure,
  isUuid,
  requireDepartmentBankAccount,
} from "../../../../../../lib/reconciliation/server/auth";
import {
  parseManualBalance,
  runConsolidation,
} from "../../../../../../lib/reconciliation/server/consolidation-service";
import {
  loadPages,
  loadSession,
  recordAuditEvent,
  ReconciliationDataError,
} from "../../../../../../lib/reconciliation/server/data-access";
import { loadSessionView } from "../../../../../../lib/reconciliation/server/load-session-view";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  const body = await parseJsonBody(request, consolidateBodySchema);
  if (isAuthFailure(body)) return failFromAuth(body);

  const context = await authorizeDepartmentRequest(request, body.departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  try {
    const session = await loadSession(context.supabase, sessionId, context.departmentId);
    if (session.status === "confirmed") {
      return fail(409, "This reconciliation is already complete and cannot be changed.");
    }
    if (session.status === "abandoned") {
      return fail(409, "This reconciliation was discarded. Start a new one.");
    }

    const pages = await loadPages(context.supabase, sessionId);
    if (!pages.some((page) => page.status === "complete")) {
      return fail(400, "Add at least one page that Hallix could read before reviewing the statement.");
    }

    const transactionLineCount = pages.reduce(
      (total, page) => total + (page.status === "complete" ? page.line_count || 0 : 0),
      0,
    );
    if (transactionLineCount === 0) {
      return fail(
        400,
        "No transactions were read from the pages yet. Add the activity pages of the statement (not just the summary), or retake any page that shows 0 transactions.",
      );
    }

    const bankAccount = session.bank_account_id
      ? await requireDepartmentBankAccount(context, session.bank_account_id)
      : null;
    if (bankAccount && isAuthFailure(bankAccount)) return failFromAuth(bankAccount);

    const outcome = await runConsolidation({
      supabase: context.supabase,
      session,
      bankAccount: bankAccount ?? null,
      overrides: {
        beginningBalanceCents: parseManualBalance(body.manualBeginningBalance),
        endingBalanceCents: parseManualBalance(body.manualEndingBalance),
        statementStartDate:
          body.manualStatementStartDate === undefined
            ? undefined
            : normalizeStatementDate(body.manualStatementStartDate),
        statementEndDate:
          body.manualStatementEndDate === undefined
            ? undefined
            : normalizeStatementDate(body.manualStatementEndDate),
      },
    });

    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId,
      eventType: "statement_consolidated",
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: {
        page_count: outcome.session.page_count,
        validation_status: outcome.session.validation_status,
        matched: outcome.session.matched_count,
        needs_review: outcome.session.needs_review_count,
        statement_only: outcome.session.statement_only_count,
        ledger_only: outcome.session.ledger_only_count,
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
    logReconciliationError("consolidate statement", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}
