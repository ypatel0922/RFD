import { NextRequest, NextResponse } from "next/server";

import { plaidClient, supabaseAdmin } from "../_lib";

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
      .select("id,transaction_date,total_amount,payee,merchant_name,category,reconciliation_status")
      .eq("department_id", departmentId);
    if (expensesResult.error) throw new Error(expensesResult.error.message);
    const expenses = expensesResult.data || [];

    let inserted = 0;
    let matched = 0;
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
      }
    }
    return NextResponse.json({ ok: true, inserted, matched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sync Plaid transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
