/**
 * Loads everything the wizard needs for one reconciliation session in a single
 * place, so every route returns an identically shaped payload.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { LedgerExpenseRow } from "../ledger";
import {
  loadLedgerCandidates,
  loadPages,
  loadSession,
  loadStatementLines,
  type SessionRow,
} from "./data-access";
import { buildSessionView, type SessionView } from "./session-view";

export async function loadSessionView(
  supabase: SupabaseClient,
  sessionId: string,
  departmentId: string,
  options?: { session?: SessionRow; ledgerRows?: LedgerExpenseRow[] },
): Promise<SessionView> {
  const session = options?.session ?? (await loadSession(supabase, sessionId, departmentId));
  const [pages, lines] = await Promise.all([
    loadPages(supabase, sessionId),
    loadStatementLines(supabase, sessionId),
  ]);

  let ledgerRows = options?.ledgerRows;
  if (!ledgerRows) {
    // Only worth a query once there are lines that could reference a transaction.
    const needsLedger =
      lines.some((line) => line.matched_expense_id || (line.candidate_expense_ids ?? []).length) ||
      (session.ledger_only_expense_ids ?? []).length > 0;
    ledgerRows = needsLedger
      ? (
          await loadLedgerCandidates(supabase, {
            departmentId,
            statementStartDate: session.statement_start_date,
            statementEndDate: session.statement_end_date,
          })
        ).rows
      : [];
  }

  return buildSessionView({ session, pages, lines, ledgerRows });
}
