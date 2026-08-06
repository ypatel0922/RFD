/**
 * Supabase reads and writes for statement reconciliation.
 *
 * Every query goes through the caller's user-scoped client, so row level
 * security is the final authority on what a department can see. Nothing in this
 * file stores an image: pages keep a one-way digest and the structured rows the
 * model produced, never the bytes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { DRAFT_RETENTION_DAYS, dateToleranceDays } from "../config";
import { addDays, type IsoDate } from "../dates";
import { centsToNumeric, parseCents, type Cents } from "../money";
import { toLedgerCandidate, type LedgerExpenseRow } from "../ledger";
import type {
  ConsolidatedLine,
  ExtractedPageHeader,
  ExtractedPageLine,
  LedgerCandidate,
  LineMatchResult,
  MatchReason,
  MatchStatus,
  PageStatus,
  SessionStatus,
  ValidationFinding,
  ValidationStatus,
} from "../types";
import type { PreviousReconciliation } from "../validate";
import type { LockedLineDecision } from "../matching";

const SESSION_COLUMNS =
  "id,department_id,bank_account_id,bank_account_name,source_type,statement_start_date,statement_end_date,beginning_balance,ending_balance,total_credits,total_debits,calculated_ending_balance,balance_difference,validation_status,validation_findings,statement_metadata,page_count,extraction_status,status,matched_count,needs_review_count,statement_only_count,ledger_only_count,ledger_only_expense_ids,created_by,created_by_email,confirmed_by,confirmed_by_email,confirmed_at,confirmed_transaction_count,override_reason,expires_at,created_at,updated_at";

const PAGE_COLUMNS =
  "id,session_id,client_page_id,page_order,status,status_detail,image_digest,extraction_model,extracted_header,extracted_lines,extraction_warnings,line_count,processed_at";

const LINE_COLUMNS =
  "id,session_id,posted_date,transaction_date,original_description,normalized_description,signed_amount,debit_amount,credit_amount,check_number,reference_number,running_balance,page_number,row_number,section_heading,extraction_confidence,extraction_warning,fingerprint,match_status,matched_expense_id,match_score,match_reasons,candidate_expense_ids,manually_corrected,confirmed_at";

export type SessionRow = {
  id: string;
  department_id: string;
  bank_account_id: string | null;
  bank_account_name: string | null;
  source_type: string;
  statement_start_date: string | null;
  statement_end_date: string | null;
  beginning_balance: string | number | null;
  ending_balance: string | number | null;
  total_credits: string | number | null;
  total_debits: string | number | null;
  calculated_ending_balance: string | number | null;
  balance_difference: string | number | null;
  validation_status: ValidationStatus;
  validation_findings: ValidationFinding[] | null;
  statement_metadata: Record<string, unknown> | null;
  page_count: number;
  extraction_status: string;
  status: SessionStatus;
  matched_count: number;
  needs_review_count: number;
  statement_only_count: number;
  ledger_only_count: number;
  ledger_only_expense_ids: string[] | null;
  created_by: string;
  created_by_email: string | null;
  confirmed_by: string | null;
  confirmed_by_email: string | null;
  confirmed_at: string | null;
  confirmed_transaction_count: number;
  override_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type PageRow = {
  id: string;
  session_id: string;
  client_page_id: string;
  page_order: number;
  status: PageStatus;
  status_detail: string | null;
  image_digest: string | null;
  extraction_model: string | null;
  extracted_header: ExtractedPageHeader | null;
  extracted_lines: ExtractedPageLine[] | null;
  extraction_warnings: string[] | null;
  line_count: number;
  processed_at: string | null;
};

export type StatementLineRow = {
  id: string;
  session_id: string;
  posted_date: string | null;
  transaction_date: string | null;
  original_description: string | null;
  normalized_description: string | null;
  signed_amount: string | number | null;
  debit_amount: string | number | null;
  credit_amount: string | number | null;
  check_number: string | null;
  reference_number: string | null;
  running_balance: string | number | null;
  page_number: number;
  row_number: number;
  section_heading: string | null;
  extraction_confidence: string | number | null;
  extraction_warning: string | null;
  fingerprint: string;
  match_status: MatchStatus;
  matched_expense_id: string | null;
  match_score: string | number | null;
  match_reasons: MatchReason[] | null;
  candidate_expense_ids: string[] | null;
  manually_corrected: boolean;
  confirmed_at: string | null;
};

export class ReconciliationDataError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ReconciliationDataError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function findOpenDraft(
  supabase: SupabaseClient,
  departmentId: string,
  bankAccountId: string,
  userId: string,
): Promise<SessionRow | null> {
  const { data, error } = await supabase
    .from("reconciliation_sessions")
    .select(SESSION_COLUMNS)
    .eq("department_id", departmentId)
    .eq("bank_account_id", bankAccountId)
    .eq("created_by", userId)
    .in("status", ["draft", "review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new ReconciliationDataError("Could not open your saved reconciliation.");
  return (data as SessionRow | null) ?? null;
}

export async function createDraftSession(
  supabase: SupabaseClient,
  input: {
    departmentId: string;
    bankAccountId: string;
    bankAccountName: string;
    userId: string;
    userEmail: string | null;
  },
): Promise<SessionRow> {
  const { data, error } = await supabase
    .from("reconciliation_sessions")
    .insert({
      department_id: input.departmentId,
      bank_account_id: input.bankAccountId,
      bank_account_name: input.bankAccountName,
      source_type: "monthly_statement",
      status: "draft",
      created_by: input.userId,
      created_by_email: input.userEmail,
      expires_at: new Date(Date.now() + DRAFT_RETENTION_DAYS * 86_400_000).toISOString(),
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error || !data) {
    throw new ReconciliationDataError("Could not start a new reconciliation. Please try again.");
  }
  return data as SessionRow;
}

export async function loadSession(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
): Promise<SessionRow> {
  const { data, error } = await supabase
    .from("reconciliation_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("department_id", departmentId)
    .maybeSingle();

  if (error) throw new ReconciliationDataError("Could not load this reconciliation.");
  if (!data) throw new ReconciliationDataError("That reconciliation was not found.", 404);
  return data as SessionRow;
}

export async function updateSession(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
  patch: Record<string, unknown>,
): Promise<SessionRow> {
  const { data, error } = await supabase
    .from("reconciliation_sessions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("department_id", departmentId)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error) throw new ReconciliationDataError("Could not save this reconciliation.");
  if (!data) throw new ReconciliationDataError("That reconciliation was not found.", 404);
  return data as SessionRow;
}

export async function loadConfirmedSessionsForAccount(
  supabase: SupabaseClient,
  departmentId: string,
  bankAccountId: string,
  excludeSessionId: string,
): Promise<PreviousReconciliation[]> {
  const { data, error } = await supabase
    .from("reconciliation_sessions")
    .select("id,statement_start_date,statement_end_date")
    .eq("department_id", departmentId)
    .eq("bank_account_id", bankAccountId)
    .eq("status", "confirmed")
    .neq("id", excludeSessionId)
    .order("statement_end_date", { ascending: false })
    .limit(36);

  if (error) return [];
  return (data || []).map((row) => ({
    sessionId: String(row.id),
    statementStartDate: (row.statement_start_date as string | null) ?? null,
    statementEndDate: (row.statement_end_date as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function loadPages(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<PageRow[]> {
  const { data, error } = await supabase
    .from("reconciliation_session_pages")
    .select(PAGE_COLUMNS)
    .eq("session_id", sessionId)
    .order("page_order", { ascending: true });

  if (error) throw new ReconciliationDataError("Could not load the statement pages.");
  return (data || []) as PageRow[];
}

/**
 * Record the outcome of reading one page. Keyed by the browser's stable page id
 * so retrying the same page replaces its previous result instead of adding a
 * second row.
 */
export async function upsertPageResult(
  supabase: SupabaseClient,
  input: {
    sessionId: string;
    departmentId: string;
    clientPageId: string;
    pageOrder: number;
    status: PageStatus;
    statusDetail: string | null;
    imageDigest: string | null;
    extractionModel: string | null;
    header: ExtractedPageHeader | null;
    lines: ExtractedPageLine[];
    warnings: string[];
  },
): Promise<PageRow> {
  const { data, error } = await supabase
    .from("reconciliation_session_pages")
    .upsert(
      {
        session_id: input.sessionId,
        department_id: input.departmentId,
        client_page_id: input.clientPageId,
        page_order: input.pageOrder,
        status: input.status,
        status_detail: input.statusDetail,
        image_digest: input.imageDigest,
        extraction_model: input.extractionModel,
        extracted_header: input.header,
        extracted_lines: input.lines,
        extraction_warnings: input.warnings,
        line_count: input.lines.length,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,client_page_id" },
    )
    .select(PAGE_COLUMNS)
    .single();

  if (error || !data) {
    throw new ReconciliationDataError("Could not save the result for this page. Try the page again.");
  }
  return data as PageRow;
}

export async function deletePage(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
  clientPageId: string,
): Promise<void> {
  const { error } = await supabase
    .from("reconciliation_session_pages")
    .delete()
    .eq("session_id", sessionId)
    .eq("department_id", departmentId)
    .eq("client_page_id", clientPageId);

  if (error) throw new ReconciliationDataError("Could not remove that page.");
}

/**
 * Drop pages that cannot be resumed without their original image bytes.
 * Failed/unreadable attempts from earlier wizard visits otherwise accumulate on
 * the draft and eventually trip the 20-page limit even when the UI looks empty.
 * Header-only "complete" pages with zero transactions are cleaned the same way.
 */
export async function deleteUnusablePages(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
): Promise<number> {
  const { data: failed, error: failedError } = await supabase
    .from("reconciliation_session_pages")
    .delete()
    .eq("session_id", sessionId)
    .eq("department_id", departmentId)
    .in("status", ["failed", "unreadable", "pending"])
    .select("id");

  if (failedError) throw new ReconciliationDataError("Could not clean up earlier page attempts.");

  const { data: empty, error: emptyError } = await supabase
    .from("reconciliation_session_pages")
    .delete()
    .eq("session_id", sessionId)
    .eq("department_id", departmentId)
    .eq("status", "complete")
    .eq("line_count", 0)
    .select("id");

  if (emptyError) throw new ReconciliationDataError("Could not clean up earlier page attempts.");

  return (failed?.length ?? 0) + (empty?.length ?? 0);
}

/** Remove every page on a draft so the treasurer can start the photos over. */
export async function deleteAllPages(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("reconciliation_session_pages")
    .delete()
    .eq("session_id", sessionId)
    .eq("department_id", departmentId)
    .select("id");

  if (error) throw new ReconciliationDataError("Could not clear the statement pages.");
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Statement lines
// ---------------------------------------------------------------------------

export async function loadStatementLines(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<StatementLineRow[]> {
  const { data, error } = await supabase
    .from("reconciliation_statement_lines")
    .select(LINE_COLUMNS)
    .eq("session_id", sessionId)
    .order("page_number", { ascending: true })
    .order("row_number", { ascending: true });

  if (error) throw new ReconciliationDataError("Could not load the statement transactions.");
  return (data || []) as StatementLineRow[];
}

export async function loadStatementLine(
  supabase: SupabaseClient,
  lineId: string,
  departmentId: string,
): Promise<StatementLineRow> {
  const { data, error } = await supabase
    .from("reconciliation_statement_lines")
    .select(LINE_COLUMNS)
    .eq("id", lineId)
    .eq("department_id", departmentId)
    .maybeSingle();

  if (error) throw new ReconciliationDataError("Could not load that statement line.");
  if (!data) throw new ReconciliationDataError("That statement line was not found.", 404);
  return data as StatementLineRow;
}

/**
 * Decisions the treasurer made by hand, keyed by fingerprint. Fed back into the
 * matcher so re-running consolidation after adding a page does not discard them.
 */
export function lockedDecisionsFrom(lines: StatementLineRow[]): Record<string, LockedLineDecision> {
  const locked: Record<string, LockedLineDecision> = {};
  for (const line of lines) {
    if (!line.manually_corrected) continue;
    locked[line.fingerprint] = {
      matchStatus: line.match_status,
      matchedExpenseId: line.matched_expense_id,
      matchScore: line.match_score == null ? null : Number(line.match_score),
      matchReasons: line.match_reasons ?? [],
    };
  }
  return locked;
}

/**
 * Replace the consolidated lines for a draft session.
 *
 * Delete-then-insert rather than a merge: the fingerprint set changes whenever a
 * page is added, replaced or reordered, and a partial merge would leave orphaned
 * rows. If the insert fails the page extractions are still stored, so re-running
 * consolidation rebuilds the same rows.
 */
export async function replaceStatementLines(
  supabase: SupabaseClient,
  input: {
    sessionId: string;
    departmentId: string;
    lines: ConsolidatedLine[];
    matches: Map<string, LineMatchResult>;
    /** Fingerprints the treasurer decided by hand; kept flagged across re-runs. */
    manualFingerprints: Set<string>;
  },
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("reconciliation_statement_lines")
    .delete()
    .eq("session_id", input.sessionId)
    .eq("department_id", input.departmentId)
    .is("confirmed_at", null);

  if (deleteError) {
    throw new ReconciliationDataError("Could not refresh the statement transactions.");
  }

  if (!input.lines.length) return;

  const rows = input.lines.map((line) => {
    const match = input.matches.get(line.fingerprint);
    return {
      session_id: input.sessionId,
      department_id: input.departmentId,
      posted_date: line.postedDate,
      transaction_date: line.transactionDate,
      original_description: line.originalDescription,
      normalized_description: line.normalizedDescription,
      signed_amount: centsToNumeric(line.signedAmountCents),
      debit_amount: centsToNumeric(line.debitAmountCents),
      credit_amount: centsToNumeric(line.creditAmountCents),
      check_number: line.checkNumber,
      reference_number: line.referenceNumber,
      running_balance: centsToNumeric(line.runningBalanceCents),
      page_number: line.pageNumber,
      row_number: line.rowNumber,
      section_heading: line.sectionHeading,
      extraction_confidence: line.extractionConfidence,
      extraction_warning: line.extractionWarning,
      fingerprint: line.fingerprint,
      match_status: match?.matchStatus ?? "unmatched",
      matched_expense_id: match?.matchedExpenseId ?? null,
      match_score: match?.matchScore ?? null,
      match_reasons: match?.matchReasons ?? [],
      candidate_expense_ids: match?.candidateExpenseIds ?? [],
      manually_corrected: input.manualFingerprints.has(line.fingerprint),
    };
  });

  // Insert in batches so a long statement stays inside PostgREST's payload limit.
  const batchSize = 200;
  for (let index = 0; index < rows.length; index += batchSize) {
    const { error } = await supabase
      .from("reconciliation_statement_lines")
      .insert(rows.slice(index, index + batchSize));
    if (error) {
      throw new ReconciliationDataError("Could not save the statement transactions.");
    }
  }
}

export async function updateStatementLine(
  supabase: SupabaseClient,
  lineId: string,
  departmentId: string,
  patch: Record<string, unknown>,
): Promise<StatementLineRow> {
  const { data, error } = await supabase
    .from("reconciliation_statement_lines")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("department_id", departmentId)
    .is("confirmed_at", null)
    .select(LINE_COLUMNS)
    .maybeSingle();

  if (error) {
    // The partial unique index is the guard against a transaction being matched
    // to two statement lines; translate it into something actionable.
    if (isUniqueViolation(error)) {
      throw new ReconciliationDataError(
        "That transaction is already matched to another line on this statement.",
        409,
      );
    }
    throw new ReconciliationDataError("Could not update that statement line.");
  }
  if (!data) {
    throw new ReconciliationDataError("That statement line was not found, or is already confirmed.", 404);
  }
  return data as StatementLineRow;
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" || Boolean(error.message?.includes("duplicate key value"));
}

// ---------------------------------------------------------------------------
// Ledger candidates
// ---------------------------------------------------------------------------

const LEDGER_COLUMNS =
  "id,transaction_date,total_amount,payee,merchant_name,description,category,fund,payment_reference,bank_account_name,reconciliation_status,reconciled_at";

/**
 * Hallix transactions that could appear on this statement: everything in the
 * department dated inside the statement period widened by the posting-date
 * tolerance. All transaction kinds are included -- checks, deposits, fees,
 * transfers, reimbursements -- because they all share the `expenses` table.
 */
export async function loadLedgerCandidates(
  supabase: SupabaseClient,
  input: {
    departmentId: string;
    statementStartDate: IsoDate | null;
    statementEndDate: IsoDate | null;
  },
): Promise<{ candidates: LedgerCandidate[]; rows: LedgerExpenseRow[] }> {
  const tolerance = dateToleranceDays();
  let query = supabase
    .from("expenses")
    .select(LEDGER_COLUMNS)
    .eq("department_id", input.departmentId)
    .limit(3000);

  if (input.statementStartDate && input.statementEndDate) {
    const from = addDays(input.statementStartDate, -tolerance);
    const to = addDays(input.statementEndDate, tolerance);
    query = query.gte("transaction_date", from).lte("transaction_date", to);
  }

  const { data, error } = await query;
  if (error) throw new ReconciliationDataError("Could not load your recorded transactions.");

  const rows = (data || []) as LedgerExpenseRow[];
  return { candidates: rows.map(toLedgerCandidate), rows };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "session_started"
  | "session_resumed"
  | "page_read"
  | "page_unreadable"
  | "page_removed"
  | "statement_consolidated"
  | "line_manually_matched"
  | "line_unmatched"
  | "line_marked_not_applicable"
  | "line_manually_corrected"
  | "line_reset"
  | "session_abandoned"
  | "reconciliation_confirmed"
  | "reconciliation_override_requested";

/**
 * Append an audit event. Never throws: a reconciliation must not fail because
 * the audit insert did. Details are structured facts only -- no image data, no
 * full account numbers, no provider payloads.
 */
export async function recordAuditEvent(
  supabase: SupabaseClient,
  input: {
    departmentId: string;
    sessionId: string | null;
    eventType: AuditEventType;
    actorUserId: string | null;
    actorEmail: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from("reconciliation_audit_events").insert({
      department_id: input.departmentId,
      session_id: input.sessionId,
      event_type: input.eventType,
      actor_user_id: input.actorUserId,
      actor_email: input.actorEmail,
      detail: input.detail ?? {},
    });
  } catch {
    // Intentionally swallowed.
  }
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function statementLineRowToCents(row: StatementLineRow): {
  signedAmountCents: Cents | null;
  runningBalanceCents: Cents | null;
} {
  return {
    signedAmountCents: parseCents(row.signed_amount),
    runningBalanceCents: parseCents(row.running_balance),
  };
}
