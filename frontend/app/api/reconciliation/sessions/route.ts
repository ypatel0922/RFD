/**
 * POST /api/reconciliation/sessions
 *
 * Starts a monthly statement reconciliation for one bank account, or resumes the
 * draft already in progress for that account so a browser refresh never loses
 * work. No statement image is involved at this stage.
 */

import { NextRequest } from "next/server";

import {
  createSessionBodySchema,
  fail,
  failFromAuth,
  logReconciliationError,
  ok,
  parseJsonBody,
  UNEXPECTED_ERROR,
} from "../../../../lib/reconciliation/server/api";
import {
  authorizeDepartmentRequest,
  isAuthFailure,
  requireDepartmentBankAccount,
} from "../../../../lib/reconciliation/server/auth";
import {
  createDraftSession,
  deleteUnusablePages,
  findOpenDraft,
  recordAuditEvent,
} from "../../../../lib/reconciliation/server/data-access";
import { loadSessionView } from "../../../../lib/reconciliation/server/load-session-view";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request, createSessionBodySchema);
  if (isAuthFailure(body)) return failFromAuth(body);

  const context = await authorizeDepartmentRequest(request, body.departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  const bankAccount = await requireDepartmentBankAccount(context, body.bankAccountId);
  if (isAuthFailure(bankAccount)) return failFromAuth(bankAccount);

  try {
    const existing = body.resumeExisting
      ? await findOpenDraft(context.supabase, context.departmentId, bankAccount.id, context.user.id)
      : null;

    const session =
      existing ??
      (await createDraftSession(context.supabase, {
        departmentId: context.departmentId,
        bankAccountId: bankAccount.id,
        bankAccountName: bankAccount.name,
        userId: context.user.id,
        userEmail: context.userEmail,
      }));

    if (existing) {
      // Images are never stored, so failed/unreadable page rows from a previous
      // visit cannot be retried and only block new uploads against the page cap.
      await deleteUnusablePages(context.supabase, session.id, context.departmentId);
    }

    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId: session.id,
      eventType: existing ? "session_resumed" : "session_started",
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: { bank_account_id: bankAccount.id },
    });

    return ok({
      resumed: Boolean(existing),
      view: await loadSessionView(context.supabase, session.id, context.departmentId, { session }),
    });
  } catch (error) {
    logReconciliationError("create session", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}
