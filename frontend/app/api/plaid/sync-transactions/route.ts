import { NextRequest, NextResponse } from "next/server";

import { plaidClient, supabaseAdmin } from "../_lib";
import { logAuditEvent } from "../../../../lib/audit-server";
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
    const expensesResult = await supabase
      .from("expenses")
      .select("id,transaction_date,total_amount,payee,merchant_name,category,reconciliation_status,receipt_path")
      .eq("department_id", departmentId);
    if (expensesResult.error) throw new Error(expensesResult.error.message);
    const expenses = expensesResult.data || [];

    // Pre-load existing pending receipt requests so we don't duplicate
    const { data: existingRequests } = await supabase
      .from("receipt_requests")
      .select("transaction_id")
      .eq("department_id", departmentId)
      .eq("status", "pending");
    const pendingTransactionIds = new Set((existingRequests || []).map((r) => r.transaction_id as string));

    // Find SMS-enabled phones for this department
    const departmentPhones = await resolveDepartmentPhones(supabase, departmentId);

    let inserted = 0;
    let matched = 0;
    let receiptRequestsSent = 0;

    for (const item of items.data || []) {
      const txResponse = await client.transactionsSync({
        access_token: item.access_token,
      });
      const rows = txResponse.data.added.map((tx) => ({
        department_id: departmentId,
        external_account_id: null,
        source: "plaid",
        external_transaction_id: tx.transaction_id,
        posted_date: tx.date,
        description: tx.name,
        amount: tx.amount,
        pending: tx.pending,
      }));
      if (rows.length) {
        const insert = await supabase.from("external_transactions").upsert(rows, {
          onConflict: "external_transaction_id",
        });
        if (insert.error) throw new Error(insert.error.message);
        inserted += rows.length;
      }

      for (const tx of txResponse.data.added) {
        const amount = Math.abs(Number(tx.amount || 0));
        const match = expenses.find((expense) => {
          const expenseAmount = Number(expense.total_amount || 0);
          const amountClose = Math.abs(Math.abs(expenseAmount) - amount) <= 15;
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
      metadata: { inserted, matched, receiptRequestsSent },
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
