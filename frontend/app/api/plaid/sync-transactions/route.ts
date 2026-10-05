import { NextRequest, NextResponse } from "next/server";

import { plaidClient, supabaseAdmin } from "../_lib";
import { logAuditEvent } from "../../../../lib/audit-server";
import {
  canAutoMatchBankRow,
  planPendingSupersession,
  type PendingSupersession,
} from "../../../../lib/money-in/plaid";
import {
  buildReceiptRequestMessage,
  generateRequestCode,
  isMissingReceiptPath,
  isTransferOrInterestDescription,
  normalizePhone,
  sendSms,
} from "../../../../lib/twilio";

export async function POST(request: NextRequest) {
  try {
    const { departmentId } = (await request.json()) as { departmentId: string };
    if (!departmentId) return NextResponse.json({ error: "Missing departmentId." }, { status: 400 });
    const client = plaidClient();
    const supabase = supabaseAdmin();

    const items = await supabase.from("plaid_items").select("id,access_token").eq("department_id", departmentId);
    if (items.error) throw new Error(items.error.message);
    const expenses = await loadMatchCandidates(supabase, departmentId);

    // Pre-load existing pending receipt requests so we don't duplicate
    const { data: existingRequests } = await supabase
      .from("receipt_requests")
      .select("transaction_id")
      .eq("department_id", departmentId)
      .eq("status", "pending");
    const pendingTransactionIds = new Set((existingRequests || []).map((r) => r.transaction_id as string));

    // Find SMS-enabled phones for this department
    const departmentPhones = await resolveDepartmentPhones(supabase, departmentId);

    const accountIdByPlaidId = await loadAccountIdMap(supabase, departmentId);
    const autoMatchedExpenseIds = new Set<string>();

    let inserted = 0;
    let matched = 0;
    let superseded = 0;
    let receiptRequestsSent = 0;

    for (const item of items.data || []) {
      const txResponse = await client.transactionsSync({
        access_token: item.access_token,
      });
      const added = txResponse.data.added;
      const pendingPredecessors = await loadPendingPredecessors(
        supabase,
        departmentId,
        added.map((tx) => tx.pending_transaction_id).filter((id): id is string => Boolean(id)),
      );
      const supersessions = planPendingSupersession(added, pendingPredecessors);
      const inheritedLink = new Set(
        supersessions.filter((plan) => plan.inheritExpenseId).map((plan) => plan.postedExternalId),
      );

      const rows = added.map((tx) => ({
        department_id: departmentId,
        external_account_id: accountIdByPlaidId.get(tx.account_id) ?? null,
        source: "plaid",
        external_transaction_id: tx.transaction_id,
        posted_date: tx.date,
        description: tx.name,
        amount: tx.amount,
        pending: tx.pending,
        pending_transaction_id: tx.pending_transaction_id ?? null,
      }));
      if (rows.length) {
        await upsertExternalTransactions(supabase, rows);
        inserted += rows.length;
      }

      superseded += await applySupersessions(supabase, departmentId, supersessions);

      const removedIds = (txResponse.data.removed || [])
        .map((tx) => tx.transaction_id)
        .filter((id): id is string => Boolean(id));
      if (removedIds.length) {
        const removal = await supabase
          .from("external_transactions")
          .update({ match_status: "superseded" })
          .eq("department_id", departmentId)
          .in("external_transaction_id", removedIds);
        if (removal.error) throw new Error(removal.error.message);
      }

      for (const tx of added) {
        if (inheritedLink.has(tx.transaction_id)) continue;
        const amount = Math.abs(Number(tx.amount || 0));
        const match = expenses.find((expense) => {
          // Incoming money is reviewed, never auto-matched, and a bank row only
          // ever meets a ledger row moving money the same direction.
          if (!canAutoMatchBankRow(Number(tx.amount || 0), expense)) return false;
          if (autoMatchedExpenseIds.has(expense.id)) return false;
          const expenseAmount = Math.abs(Number(expense.total_amount || 0));
          // A pending authorization is taken before the tip is added, so a
          // tipped expense should also match its pre-tip amount.
          const tip = Math.abs(Number(expense.tip_amount || 0));
          const preTipAmount = tip > 0 ? expenseAmount - tip : expenseAmount;
          const amountClose =
            Math.abs(expenseAmount - amount) <= 15 || Math.abs(preTipAmount - amount) <= 15;
          const vendor = (expense.payee || expense.merchant_name || "").toLowerCase();
          const desc = (tx.name || "").toLowerCase();
          const vendorClose =
            vendor && (desc.includes(vendor) || vendor.split(" ").some((word: string) => word && desc.includes(word)));
          const dateClose =
            expense.transaction_date &&
            Math.abs(new Date(expense.transaction_date).getTime() - new Date(tx.date).getTime()) <= 3 * 86400000;
          return amountClose && (vendorClose || Boolean(dateClose));
        });
        if (!match) continue;
        autoMatchedExpenseIds.add(match.id);
        const updateExpense = await supabase
          .from("expenses")
          .update({
            reconciliation_status: "matched",
            bank_posted_date: tx.date,
            bank_description: tx.name,
            bank_amount: tx.amount,
            bank_match_confidence: 0.8,
            reconciled_at: new Date().toISOString(),
          })
          .eq("id", match.id);
        if (updateExpense.error) throw new Error(updateExpense.error.message);
        const updateTx = await supabase
          .from("external_transactions")
          .update({
            expense_id: match.id,
            match_status: "matched",
            match_confidence: 0.8,
          })
          .eq("external_transaction_id", tx.transaction_id);
        if (updateTx.error) throw new Error(updateTx.error.message);
        matched += 1;
        await logAuditEvent({
          departmentId,
          action: "transaction.plaid_matched",
          resourceType: "expense",
          resourceId: match.id,
          resourceLabel: match.payee || match.merchant_name || undefined,
          afterData: {
            reconciliation_status: "matched",
            bank_posted_date: tx.date,
            bank_description: tx.name,
          },
          metadata: { plaidTransactionId: tx.transaction_id },
          request,
        });
      }

      // Post-import: request receipts for new expense-type transactions
      if (departmentPhones.length > 0) {
        for (const tx of txResponse.data.added) {
          // Skip pending, income (negative in Plaid = money in), and transfers
          if (tx.pending) continue;
          if (Number(tx.amount) <= 0) continue;
          if (isTransferOrInterestDescription(tx.name || "")) continue;

          // Find the inserted external_transaction id
          const { data: extTxRow } = await supabase
            .from("external_transactions")
            .select("id, expense_id")
            .eq("external_transaction_id", tx.transaction_id)
            .maybeSingle();
          if (!extTxRow) continue;

          // Skip if already has a pending receipt request
          if (pendingTransactionIds.has(extTxRow.id)) continue;

          // Skip if linked expense already has a real receipt
          if (extTxRow.expense_id) {
            const linkedExpense = expenses.find((e) => e.id === extTxRow.expense_id);
            if (linkedExpense && !isMissingReceiptPath(linkedExpense.receipt_path)) {
              continue;
            }
          }

          // Use the first available SMS-enabled phone
          const phone = departmentPhones[0];
          const requestCode = generateRequestCode();
          const vendor = tx.name || "Unknown vendor";
          const date = tx.date;
          const messageBody = buildReceiptRequestMessage({
            amount: tx.amount,
            vendor,
            date,
            requestCode,
          });

          let twilioSid: string | null = null;
          let requestStatus = "pending";
          try {
            const smsResult = await sendSms({ to: normalizePhone(phone.phone), body: messageBody });
            twilioSid = smsResult.sid;
          } catch {
            requestStatus = "failed";
          }

          const now = new Date().toISOString();
          await supabase.from("receipt_requests").insert({
            department_id: departmentId,
            transaction_id: extTxRow.id,
            expense_id: extTxRow.expense_id || null,
            user_id: phone.userId || null,
            phone_number: normalizePhone(phone.phone),
            request_code: requestCode,
            status: requestStatus,
            sent_at: requestStatus === "pending" ? now : null,
            twilio_message_sid: twilioSid,
          });

          pendingTransactionIds.add(extTxRow.id);
          if (requestStatus === "pending") receiptRequestsSent += 1;
        }
      }
    }

    await logAuditEvent({
      departmentId,
      action: "plaid.sync_run",
      resourceType: "plaid",
      metadata: { inserted, matched, superseded, receiptRequestsSent },
      request,
    });

    if (inserted > 0) {
      await logAuditEvent({
        departmentId,
        action: "plaid.transaction_imported",
        resourceType: "plaid",
        metadata: { count: inserted },
        request,
      });
    }

    return NextResponse.json({ ok: true, inserted, matched, receiptRequestsSent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sync Plaid transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type PhoneEntry = { phone: string; userId: string | null };

const BASE_MATCH_COLUMNS =
  "id,transaction_date,total_amount,payee,merchant_name,category,reconciliation_status,receipt_path";

type MatchCandidate = {
  id: string;
  transaction_date: string | null;
  total_amount: number | string | null;
  payee: string | null;
  merchant_name: string | null;
  category: string | null;
  reconciliation_status: string | null;
  receipt_path: string | null;
  tip_amount?: number | string | null;
  transaction_type?: string | null;
};

type AdminClient = ReturnType<typeof supabaseAdmin>;

function isMissingColumnError(message: string | undefined, column: string): boolean {
  const text = (message || "").toLowerCase();
  return text.includes(column) && (text.includes("column") || text.includes("schema cache"));
}

/** Plaid account_id → external_accounts.id, so imported rows keep their account. */
async function loadAccountIdMap(supabase: AdminClient, departmentId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("external_accounts")
    .select("id,external_account_id")
    .eq("department_id", departmentId);
  if (error) return new Map();
  return new Map((data || []).map((row) => [String(row.external_account_id), String(row.id)]));
}

async function loadPendingPredecessors(
  supabase: AdminClient,
  departmentId: string,
  pendingIds: string[],
): Promise<Map<string, { id: string; expense_id: string | null; match_status: string | null }>> {
  const map = new Map<string, { id: string; expense_id: string | null; match_status: string | null }>();
  if (!pendingIds.length) return map;
  const { data, error } = await supabase
    .from("external_transactions")
    .select("id,external_transaction_id,expense_id,match_status")
    .eq("department_id", departmentId)
    .in("external_transaction_id", pendingIds);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    map.set(String(row.external_transaction_id), {
      id: String(row.id),
      expense_id: (row.expense_id as string | null) ?? null,
      match_status: (row.match_status as string | null) ?? null,
    });
  }
  return map;
}

/** pending_transaction_id arrived with migration 024; older projects skip it. */
async function upsertExternalTransactions(supabase: AdminClient, rows: Array<Record<string, unknown>>) {
  const first = await supabase.from("external_transactions").upsert(rows, { onConflict: "external_transaction_id" });
  if (!first.error) return;
  if (!isMissingColumnError(first.error.message, "pending_transaction_id")) throw new Error(first.error.message);
  const legacyRows = rows.map(({ pending_transaction_id: _omit, ...rest }) => rest);
  const retry = await supabase.from("external_transactions").upsert(legacyRows, { onConflict: "external_transaction_id" });
  if (retry.error) throw new Error(retry.error.message);
}

/**
 * The posted row takes over the pending row's link and the pending row is
 * marked superseded, so the same money is never counted twice.
 */
async function applySupersessions(
  supabase: AdminClient,
  departmentId: string,
  plans: PendingSupersession[],
): Promise<number> {
  let applied = 0;
  for (const plan of plans) {
    const { data: posted, error } = await supabase
      .from("external_transactions")
      .select("id,expense_id")
      .eq("department_id", departmentId)
      .eq("external_transaction_id", plan.postedExternalId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!posted) continue;

    if (plan.inheritExpenseId && !posted.expense_id) {
      const link = await supabase
        .from("external_transactions")
        .update({ expense_id: plan.inheritExpenseId, match_status: plan.inheritMatchStatus || "matched" })
        .eq("id", posted.id);
      if (link.error) throw new Error(link.error.message);
    }

    const supersede = await supabase
      .from("external_transactions")
      .update({ match_status: "superseded", superseded_by_id: posted.id, expense_id: null })
      .eq("id", plan.pendingRowId)
      .eq("department_id", departmentId);
    if (supersede.error) {
      if (!isMissingColumnError(supersede.error.message, "superseded_by_id")) throw new Error(supersede.error.message);
      const legacy = await supabase
        .from("external_transactions")
        .update({ match_status: "superseded", expense_id: null })
        .eq("id", plan.pendingRowId)
        .eq("department_id", departmentId);
      if (legacy.error) throw new Error(legacy.error.message);
    }
    applied += 1;
  }
  return applied;
}

/**
 * Load the expenses a synced transaction could match.
 *
 * tip_amount and transaction_type arrived in later migrations, so a project
 * that has not run them yet falls back to an older column set rather than
 * failing the whole sync.
 */
async function loadMatchCandidates(
  supabase: ReturnType<typeof supabaseAdmin>,
  departmentId: string,
): Promise<MatchCandidate[]> {
  const withType = await supabase
    .from("expenses")
    .select(`${BASE_MATCH_COLUMNS},tip_amount,transaction_type`)
    .eq("department_id", departmentId);
  if (!withType.error) return (withType.data || []) as MatchCandidate[];

  const withTip = await supabase
    .from("expenses")
    .select(`${BASE_MATCH_COLUMNS},tip_amount`)
    .eq("department_id", departmentId);
  if (!withTip.error) return (withTip.data || []) as MatchCandidate[];

  const base = await supabase
    .from("expenses")
    .select(BASE_MATCH_COLUMNS)
    .eq("department_id", departmentId);
  if (base.error) throw new Error(base.error.message);
  return (base.data || []) as MatchCandidate[];
}

/**
 * Find phone numbers for SMS receipt requests in a department.
 * Priority: user_notification_prefs → user_metadata.phone for each member.
 */
async function resolveDepartmentPhones(
  supabase: ReturnType<typeof supabaseAdmin>,
  departmentId: string,
): Promise<PhoneEntry[]> {
  // Check user_notification_prefs first
  const { data: prefs } = await supabase
    .from("user_notification_prefs")
    .select("user_id, phone_number, sms_receipt_requests_enabled")
    .eq("department_id", departmentId)
    .eq("sms_receipt_requests_enabled", true)
    .not("phone_number", "is", null);

  if (prefs && prefs.length > 0) {
    return prefs
      .filter((p) => p.phone_number)
      .map((p) => ({ phone: p.phone_number!, userId: p.user_id }));
  }

  // Fall back to user_metadata.phone for department members
  const { data: members } = await supabase
    .from("department_members")
    .select("user_id")
    .eq("department_id", departmentId)
    .limit(5);

  if (!members?.length) return [];

  const phones: PhoneEntry[] = [];
  for (const member of members) {
    try {
      const { data: userResult } = await supabase.auth.admin.getUserById(member.user_id);
      const phone = (userResult.user?.user_metadata?.phone as string | undefined) || null;
      if (phone) {
        phones.push({ phone, userId: member.user_id });
      }
    } catch {
      // Skip if user lookup fails
    }
  }

  return phones;
}
