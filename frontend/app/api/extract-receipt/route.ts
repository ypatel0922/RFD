import { NextRequest, NextResponse } from "next/server";

import { extractReceiptFromBuffer, FALLBACK_EXTRACTION } from "../../../lib/extract-receipt-server";

/**
 * Category names the caller may choose from. These come from the signed-in
 * user's own department data, already scoped by RLS on the client. A bad value
 * only limits that caller's own suggestion — it never reads other departments.
 */
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

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const receipt = formData.get("receipt");

  if (!(receipt instanceof File)) {
    return NextResponse.json(
      { ...FALLBACK_EXTRACTION, notes: "Upload a receipt file." },
      { status: 400 },
    );
  }

  const allowedCategories = parseAllowedCategories(formData.get("categories"));
  const bytes = Buffer.from(await receipt.arrayBuffer());
  const result = await extractReceiptFromBuffer(bytes, receipt.type, { allowedCategories });
  return NextResponse.json(result);
}
