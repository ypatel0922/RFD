import { NextRequest, NextResponse } from "next/server";

import { extractReceiptFromBuffer, FALLBACK_EXTRACTION } from "../../../lib/extract-receipt-server";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const receipt = formData.get("receipt");

  if (!(receipt instanceof File)) {
    return NextResponse.json(
      { ...FALLBACK_EXTRACTION, notes: "Upload a receipt file." },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await receipt.arrayBuffer());
  const result = await extractReceiptFromBuffer(bytes, receipt.type);
  return NextResponse.json(result);
}
