import { timingSafeEqual } from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "../plaid/_lib";

function safeCompareInvite(stored: string, provided: string) {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  try {
    const { departmentId, inviteCode } = (await request.json()) as {
      departmentId?: string;
      inviteCode?: string;
    };
    if (!departmentId || typeof inviteCode !== "string") {
      return NextResponse.json({ ok: false, error: "Missing department or invite code." }, { status: 400 });
    }

    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from("department_signup_secrets")
      .select("invite_code")
      .eq("department_id", departmentId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!data?.invite_code) {
      return NextResponse.json({
        ok: false,
        error: "This department is not open for signup yet. Contact your administrator.",
      });
    }

    const ok = safeCompareInvite(data.invite_code, inviteCode.trim());
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Invalid department access code." });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verification failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
