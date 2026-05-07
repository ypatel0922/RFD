import { NextRequest, NextResponse } from "next/server";

import { plaidRequest, supabaseAdmin } from "../_lib";

export async function POST(request: NextRequest) {
  try {
    const { publicToken, departmentId } = (await request.json()) as {
      publicToken: string;
      departmentId: string;
    };
    if (!publicToken || !departmentId) {
      return NextResponse.json({ error: "Missing publicToken or departmentId." }, { status: 400 });
    }
    const supabase = supabaseAdmin();
    const exchange = await plaidRequest<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token: publicToken },
    );
    const accessToken = exchange.access_token;
    const itemId = exchange.item_id;
    const itemInfo = await plaidRequest<{ item?: { institution_id?: string | null } }>("/item/get", {
      access_token: accessToken,
    });
    const institutionName = itemInfo.item?.institution_id || "Plaid Institution";

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

    const accounts = await plaidRequest<{
      accounts: Array<{
        account_id: string;
        name: string;
        mask?: string | null;
        type: string;
        subtype?: string | null;
      }>;
    }>("/accounts/get", {
      access_token: accessToken,
    });
    const accountRows = accounts.accounts.map((account) => ({
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

    return NextResponse.json({ ok: true, accounts: accountRows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not exchange Plaid token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
