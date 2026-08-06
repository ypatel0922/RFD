import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

type DemoRequestBody = {
  fullName?: string;
  departmentName?: string;
  phoneNumber?: string;
  email?: string;
  companyWebsite?: string;
};

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DemoRequestBody;

    if (trim(body.companyWebsite)) {
      return NextResponse.json({ ok: true });
    }

    const fullName = trim(body.fullName);
    const departmentName = trim(body.departmentName);
    const email = trim(body.email);
    const phoneNumber = trim(body.phoneNumber);

    if (!fullName || !departmentName || !email) {
      return NextResponse.json(
        { ok: false, error: "Full name, department name, and email are required." },
        { status: 400 },
      );
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const toEmail = process.env.DEMO_REQUEST_TO_EMAIL;

    if (!resendApiKey || !toEmail) {
      return NextResponse.json({ ok: false, error: "Email service is not configured." }, { status: 500 });
    }

    const resend = new Resend(resendApiKey);
    const submittedAt = new Date().toISOString();

    const phoneLine = phoneNumber ? `Phone Number: ${phoneNumber}` : "Phone Number: (not provided)";

    const { error } = await resend.emails.send({
      from: "Hallix <onboarding@resend.dev>",
      to: toEmail,
      subject: "New Hallix Demo Request",
      text: [
        "New Hallix Demo Request",
        "",
        `Full Name: ${fullName}`,
        `Department Name: ${departmentName}`,
        phoneLine,
        `Email: ${email}`,
        `Submitted timestamp: ${submittedAt}`,
      ].join("\n"),
    });

    if (error) {
      return NextResponse.json({ ok: false, error: "Failed to send notification." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
