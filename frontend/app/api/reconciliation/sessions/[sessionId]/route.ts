/**
 * GET    /api/reconciliation/sessions/:sessionId  -- resume a draft after a refresh
 * DELETE /api/reconciliation/sessions/:sessionId  -- abandon a draft
 *
 * A refresh can never reconcile anything: this route only reads, and abandoning
 * is refused once a session has been confirmed.
 */

import { NextRequest } from "next/server";

import {
  fail,
  failFromAuth,
  logReconciliationError,
  ok,
  UNEXPECTED_ERROR,
} from "../../../../../lib/reconciliation/server/api";
import { authorizeDepartmentRequest, isAuthFailure, isUuid } from "../../../../../lib/reconciliation/server/auth";
import {
  loadSession,
  recordAuditEvent,
  ReconciliationDataError,
  updateSession,
} from "../../../../../lib/reconciliation/server/data-access";
import { loadSessionView } from "../../../../../lib/reconciliation/server/load-session-view";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  const departmentId = request.nextUrl.searchParams.get("departmentId");

  const context = await authorizeDepartmentRequest(request, departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  try {
    return ok({ view: await loadSessionView(context.supabase, sessionId, context.departmentId) });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    logReconciliationError("load session", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}

export async function DELETE(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  const departmentId = request.nextUrl.searchParams.get("departmentId");

  const context = await authorizeDepartmentRequest(request, departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  try {
    const session = await loadSession(context.supabase, sessionId, context.departmentId);
    if (session.status === "confirmed") {
      return fail(409, "This reconciliation is already complete and cannot be discarded.");
    }

    await updateSession(context.supabase, sessionId, context.departmentId, { status: "abandoned" });
    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId,
      eventType: "session_abandoned",
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: { page_count: session.page_count },
    });

    return ok({ abandoned: true });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    logReconciliationError("abandon session", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}
