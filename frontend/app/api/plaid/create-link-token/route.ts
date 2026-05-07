import { NextRequest, NextResponse } from "next/server";

import { plaidRequest } from "../_lib";

export async function POST(request: NextRequest) {
  try {
    const { userId, departmentId } = (await request.json()) as {
      userId: string;
      departmentId: string;
    };
    if (!userId || !departmentId) {
      return NextResponse.json({ error: "Missing userId or departmentId." }, { status: 400 });
    }
    const response = await plaidRequest<{ link_token: string }>("/link/token/create", {
      user: { client_user_id: userId },
      client_name: "RFD Expense Tracker",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: process.env.PLAID_REDIRECT_URI,
      webhook: process.env.PLAID_WEBHOOK_URL,
    });
    return NextResponse.json({ link_token: response.link_token });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create Plaid link token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
