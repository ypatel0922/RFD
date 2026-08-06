/**
 * POST   /api/reconciliation/sessions/:sessionId/pages -- read ONE statement page
 * DELETE /api/reconciliation/sessions/:sessionId/pages -- remove one page
 *
 * IMAGE HANDLING
 * --------------
 * The uploaded bytes exist only as an in-memory Buffer inside this handler. They
 * are inspected, sent to the configured vision provider, and then go out of
 * scope. Nothing is written to Supabase Storage, no base64 is stored in the
 * database, and no image content is logged. What survives is the structured
 * extraction (dates, descriptions, amounts) plus a SHA-256 digest used only to
 * notice that the same photo was added twice.
 *
 * One page per request keeps a ten-page statement from becoming one oversized
 * serverless request, and lets the browser retry a single failed page without
 * reprocessing the pages that already succeeded.
 */

import { NextRequest } from "next/server";

import { MAX_PAGES_PER_SESSION, MAX_PAGE_BYTES } from "../../../../../../lib/reconciliation/config";
import {
  deletePageQuerySchema,
  fail,
  failFromAuth,
  logReconciliationError,
  ok,
  UNEXPECTED_ERROR,
} from "../../../../../../lib/reconciliation/server/api";
import {
  authorizeDepartmentRequest,
  isAuthFailure,
  isUuid,
  requireDepartmentBankAccount,
} from "../../../../../../lib/reconciliation/server/auth";
import { runConsolidation } from "../../../../../../lib/reconciliation/server/consolidation-service";
import {
  deleteAllPages,
  deletePage,
  deleteUnusablePages,
  loadPages,
  loadSession,
  recordAuditEvent,
  ReconciliationDataError,
  upsertPageResult,
} from "../../../../../../lib/reconciliation/server/data-access";
import { loadSessionView } from "../../../../../../lib/reconciliation/server/load-session-view";
import { extractStatementPage } from "../../../../../../lib/reconciliation/server/page-extraction";
import {
  createVisionProvider,
  isVisionProviderConfigured,
  VisionProviderError,
} from "../../../../../../lib/reconciliation/server/vision-provider";

export const runtime = "nodejs";
/** A dense statement page can take a while to transcribe accurately. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "That page could not be uploaded. Please try again.");
  }

  const departmentId = stringField(form, "departmentId");
  const clientPageId = stringField(form, "clientPageId");
  const pageOrderRaw = stringField(form, "pageOrder");
  const totalPagesRaw = stringField(form, "totalPages");
  const file = form.get("page");

  const context = await authorizeDepartmentRequest(request, departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  if (!clientPageId || clientPageId.length > 128) {
    return fail(400, "That page could not be uploaded. Please try again.");
  }
  if (!(file instanceof File)) {
    return fail(400, "Choose a photo or PDF page to add.");
  }
  if (file.size > MAX_PAGE_BYTES) {
    return fail(413, "That page is too large. Retake the photo and it will be resized automatically.");
  }

  const pageOrder = clampPageOrder(pageOrderRaw);
  const totalPages = clampPageOrder(totalPagesRaw);

  if (!isVisionProviderConfigured()) {
    return fail(
      503,
      "Statement reading is not turned on for this site yet. Ask your administrator to finish setup.",
    );
  }

  try {
    const session = await loadSession(context.supabase, sessionId, context.departmentId);
    if (session.status === "confirmed") {
      return fail(409, "This reconciliation is already complete. Start a new one to read another statement.");
    }
    if (session.status === "abandoned") {
      return fail(409, "This reconciliation was discarded. Start a new one.");
    }

    // Earlier failed uploads leave rows on the draft. The UI may look empty after
    // a refresh (images are not kept), so clean those out before enforcing the
    // page cap — otherwise a 4-page statement can hit "at most 20 pages".
    await deleteUnusablePages(context.supabase, sessionId, context.departmentId);

    const existingPages = await loadPages(context.supabase, sessionId);
    const isNewPage = !existingPages.some((page) => page.client_page_id === clientPageId);
    if (isNewPage && existingPages.length >= MAX_PAGES_PER_SESSION) {
      return fail(
        400,
        `A statement can have at most ${MAX_PAGES_PER_SESSION} pages. Remove a page before adding another.`,
      );
    }

    // Held only for the duration of this request.
    const bytes = Buffer.from(await file.arrayBuffer());

    const outcome = await extractStatementPage({
      bytes,
      mimeType: file.type || "application/octet-stream",
      pageNumber: pageOrder,
      totalPages: Math.max(totalPages, pageOrder),
      provider: createVisionProvider(),
    });

    if (outcome.status === "complete") {
      await upsertPageResult(context.supabase, {
        sessionId,
        departmentId: context.departmentId,
        clientPageId,
        pageOrder,
        status: "complete",
        statusDetail: null,
        imageDigest: outcome.imageDigest,
        extractionModel: outcome.result.model,
        header: outcome.result.header,
        lines: outcome.result.lines,
        warnings: outcome.result.warnings,
      });

      await recordAuditEvent(context.supabase, {
        departmentId: context.departmentId,
        sessionId,
        eventType: "page_read",
        actorUserId: context.user.id,
        actorEmail: context.userEmail,
        detail: {
          page_order: pageOrder,
          line_count: outcome.result.lines.length,
          model: outcome.result.model,
        },
      });

      return ok({
        page: {
          clientPageId,
          pageOrder,
          status: "complete" as const,
          statusDetail: null,
          lineCount: outcome.result.lines.length,
          printedPageNumber: outcome.result.header.printedPageNumber,
          printedPageCount: outcome.result.header.printedPageCount,
          warnings: outcome.result.warnings,
        },
      });
    }

    const status = outcome.status === "unreadable" ? ("unreadable" as const) : ("failed" as const);
    await upsertPageResult(context.supabase, {
      sessionId,
      departmentId: context.departmentId,
      clientPageId,
      pageOrder,
      status,
      statusDetail: outcome.reason,
      imageDigest: outcome.imageDigest,
      extractionModel: null,
      header: null,
      lines: [],
      warnings: [outcome.reason],
    });

    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId,
      eventType: "page_unreadable",
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: { page_order: pageOrder, status },
    });

    return ok({
      page: {
        clientPageId,
        pageOrder,
        status,
        statusDetail: outcome.reason,
        lineCount: 0,
        printedPageNumber: null,
        printedPageCount: null,
        warnings: [outcome.reason],
      },
    });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    if (error instanceof VisionProviderError) return fail(502, error.message);
    logReconciliationError("read page", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}

export async function DELETE(request: NextRequest, routeContext: RouteContext) {
  const { sessionId } = await routeContext.params;
  if (!isUuid(sessionId)) return fail(400, "That reconciliation link is not valid.");

  const parsed = deletePageQuerySchema.safeParse({
    departmentId: request.nextUrl.searchParams.get("departmentId"),
    clientPageId: request.nextUrl.searchParams.get("clientPageId") || undefined,
    clearAll: request.nextUrl.searchParams.get("clearAll") || undefined,
  });
  if (!parsed.success) return fail(400, "That page could not be removed. Please try again.");

  const context = await authorizeDepartmentRequest(request, parsed.data.departmentId);
  if (isAuthFailure(context)) return failFromAuth(context);

  try {
    const session = await loadSession(context.supabase, sessionId, context.departmentId);
    if (session.status === "confirmed") {
      return fail(409, "This reconciliation is already complete.");
    }

    const clearAll = parsed.data.clearAll === "1" || parsed.data.clearAll === "true";
    if (clearAll) {
      await deleteAllPages(context.supabase, sessionId, context.departmentId);
    } else if (parsed.data.clientPageId) {
      await deletePage(context.supabase, sessionId, context.departmentId, parsed.data.clientPageId);
    }

    await recordAuditEvent(context.supabase, {
      departmentId: context.departmentId,
      sessionId,
      eventType: "page_removed",
      actorUserId: context.user.id,
      actorEmail: context.userEmail,
      detail: clearAll ? { clear_all: true } : { client_page_id: parsed.data.clientPageId },
    });

    // Removing a page changes the statement, so the consolidated view is rebuilt
    // from the pages that remain.
    const bankAccount = session.bank_account_id
      ? await requireDepartmentBankAccount(context, session.bank_account_id)
      : null;

    const remaining = await loadPages(context.supabase, sessionId);
    if (remaining.some((page) => page.status === "complete")) {
      const outcome = await runConsolidation({
        supabase: context.supabase,
        session,
        bankAccount: bankAccount && !isAuthFailure(bankAccount) ? bankAccount : null,
      });
      return ok({
        view: await loadSessionView(context.supabase, sessionId, context.departmentId, {
          session: outcome.session,
          ledgerRows: outcome.ledgerRows,
        }),
      });
    }

    return ok({ view: await loadSessionView(context.supabase, sessionId, context.departmentId) });
  } catch (error) {
    if (error instanceof ReconciliationDataError) return fail(error.status, error.message);
    logReconciliationError("remove page", error);
    return fail(500, UNEXPECTED_ERROR);
  }
}

function stringField(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampPageOrder(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_PAGES_PER_SESSION);
}
