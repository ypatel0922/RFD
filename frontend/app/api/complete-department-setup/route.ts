import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../plaid/_lib";

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return NextResponse.json({ error: "Missing access token." }, { status: 401 });
    }

    const { departmentId } = (await request.json()) as { departmentId?: string };
    if (!departmentId) {
      return NextResponse.json({ error: "Missing departmentId." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      return NextResponse.json({ error: "Server Supabase env not configured." }, { status: 500 });
    }

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    const { data: member, error: memberError } = await userClient
      .from("department_members")
      .select("department_id")
      .eq("department_id", departmentId)
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (memberError || !member) {
      return NextResponse.json({ error: "Not a member of this department." }, { status: 403 });
    }

    const admin = supabaseAdmin();
    const { error: updateError } = await admin
      .from("departments")
      .update({ setup_completed_at: new Date().toISOString() })
      .eq("id", departmentId)
      .is("setup_completed_at", null);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete setup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
