import { NextRequest, NextResponse } from "next/server";

import { plaidClient, supabaseAdmin } from "../_lib";

export async function POST(request: NextRequest) {
  try {
    const { publicToken, departmentId } = (await request.json()) as {
      publicToken: string;
      departmentId: string;
    };
    if (!publicToken || !departmentId) {
      return NextResponse.json({ error: "Missing publicToken or departmentId." }, { status: 400 });
    }
    const client = plaidClient();
    const supabase = supabaseAdmin();
    const exchange = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;
    const itemInfo = await client.itemGet({ access_token: accessToken });
    const institutionName = itemInfo.data.item.institution_id || "Plaid Institution";

    const itemInsert = await supabase
      .from("plaid_items")
      .upsert({
        department_id: departmentId,
        item_id: itemId,
        access_token: accessToken,
        institution_name: institutionName,
      })
      .select("id")
      .single();
    if (itemInsert.error) throw new Error(itemInsert.error.message);
    const plaidItemId = itemInsert.data.id;

    const accounts = await client.accountsGet({ access_token: accessToken });
    const accountRows = accounts.data.accounts.map((account) => ({
      department_id: departmentId,
      plaid_item_id: plaidItemId,
      external_account_id: account.account_id,
      name: account.name,
      mask: account.mask || null,
      type: account.type,
      subtype: account.subtype || null,
      source: "plaid",
    }));
    if (accountRows.length) {
      const result = await supabase.from("external_accounts").upsert(accountRows, {
        onConflict: "external_account_id",
      });
      if (result.error) throw new Error(result.error.message);
    }

    await supabase
      .from("departments")
      .update({ setup_completed_at: new Date().toISOString() })
      .eq("id", departmentId)
      .is("setup_completed_at", null);

    return NextResponse.json({ ok: true, accounts: accountRows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not exchange Plaid token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
