/**
 * Permanently reconcile the confirmed matches.
 *
 * All of the work happens inside `confirm_statement_reconciliation`, a single
 * plpgsql function, so marking expenses reconciled, stamping the statement
 * lines, updating the account's last-reconciled figures and writing the audit
 * row either all succeed or all roll back. Re-posting the same confirmation
 * returns the original result rather than reconciling anything twice.
 */

import type { NextRequest } from "next/server";

import {
  confirmBodySchema,
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
} from "../../../../../../lib/reconciliation/server/auth";
import {
  CONFIRM_FAILURES,
  mapConfirmError,
  MIN_OVERRIDE_REASON_LENGTH,
} from "../../../../../../lib/reconciliation/server/confirm-errors";
import {
  loadSession,
  ReconciliationDataError,
} from "../../../../../../lib/reconciliation/server/data-access";
import { loadSessionView } from "../../../../../../lib/reconciliation/server/load-session-view";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  const body = await parseJsonBody(request, confirmBodySchema);
  if (isAuthFailure(body)) return failFromAuth(body);

  const context = await authorizeDepartmentRequest(request, body.departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  try {
    // Reading the session first turns a cross-department attempt into a clean
    // 404 instead of an opaque RLS failure inside the function.
    const session = await loadSession(context.supabase, sessionId, context.departmentId);

    if (session.status === "confirmed") {
      return ok({
        alreadyConfirmed: true,
        confirmedCount: session.confirmed_transaction_count ?? 0,
        confirmedAt: session.confirmed_at,
        view: await loadSessionView(context.supabase, sessionId, context.departmentId, { session }),
      });
    }

    const overrideReason = body.overrideReason?.trim() || null;
    if (
      session.validation_status !== "balanced" &&
      (overrideReason?.length ?? 0) < MIN_OVERRIDE_REASON_LENGTH
    ) {
      return fail(400, CONFIRM_FAILURES.RECONCILIATION_REQUIRES_BALANCED_STATEMENT.message);
    }

    const { data, error } = await context.supabase.rpc("confirm_statement_reconciliation", {
      p_session_id: sessionId,
      p_line_ids: body.lineIds,
      p_override_reason: overrideReason,
    });

    if (error) {
      const mapped = mapConfirmError(error.message);
      if (mapped) return fail(mapped.status, mapped.message);
      logReconciliationError("confirm reconciliation", new Error(error.message));
      return fail(500, UNEXPECTED_ERROR);
    }

    const result = (data ?? {}) as {
      already_confirmed?: boolean;
      confirmed_count?: number;
      confirmed_at?: string;
    };

    return ok({
      alreadyConfirmed: Boolean(result.already_confirmed),
      confirmedCount: result.confirmed_count ?? 0,
      confirmedAt: result.confirmed_at ?? null,
      view: await loadSessionView(context.supabase, sessionId, context.departmentId),
    });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    logReconciliationError("confirm reconciliation", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}
