import { NextRequest, NextResponse } from "next/server";

import { extractMoneyInFromBuffer, FALLBACK_MONEY_IN_EXTRACTION } from "../../../lib/extract-money-in-server";
import { authorizeDepartmentRequest, isAuthFailure } from "../../../lib/reconciliation/server/auth";

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

function parseAllowedCategories(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/**
 * Read a check or payment document. Checks carry banking details, so unlike
 * receipt OCR this route only serves signed-in members of the department the
 * document belongs to, and it never stores or echoes the image.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const departmentId = formData.get("department_id");
  const auth = await authorizeDepartmentRequest(request, typeof departmentId === "string" ? departmentId : null);
  if (isAuthFailure(auth)) {
    return NextResponse.json({ ...FALLBACK_MONEY_IN_EXTRACTION, notes: auth.message }, { status: auth.status });
  }

  const document = formData.get("document");
  if (!(document instanceof File)) {
    return NextResponse.json(
      { ...FALLBACK_MONEY_IN_EXTRACTION, notes: "Upload a check or document." },
      { status: 400 },
    );
  }
  if (document.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      { ...FALLBACK_MONEY_IN_EXTRACTION, notes: "That file is too large to read. Enter the details manually." },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await document.arrayBuffer());
  const result = await extractMoneyInFromBuffer(bytes, document.type, {
    allowedCategories: parseAllowedCategories(formData.get("categories")),
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
