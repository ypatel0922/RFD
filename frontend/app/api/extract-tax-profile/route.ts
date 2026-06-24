import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

type TaxProfileExtraction = {
  entity_name: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  entity_type: string | null;
  treasurer_name: string | null;
  treasurer_email: string | null;
  treasurer_phone: string | null;
};

const FALLBACK: TaxProfileExtraction = {
  entity_name: null,
  address: null,
  city: null,
  county: null,
  zip: null,
  entity_type: null,
  treasurer_name: null,
  treasurer_email: null,
  treasurer_phone: null,
};

const PROMPT = `You are extracting entity and treasurer information from a New York State Foreign Fire Insurance filing or similar government document.
Return ONLY valid JSON with exactly these keys (use null for any field not found):
entity_name, address, city, county, zip, entity_type, treasurer_name, treasurer_email, treasurer_phone.
- entity_name: the name of the fire company, fire department, or organization
- address: street address only (no city/state/zip)
- city: city name
- county: New York county name (without "County")
- zip: 5-digit ZIP code
- entity_type: one of "Volunteer Fire Company", "Volunteer Fire Department", "Paid Fire Department", "Fire District", "Other"
- treasurer_name: full name of the treasurer or certifying officer
- treasurer_email: email address of treasurer if present
- treasurer_phone: phone number of treasurer if present`;

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ ...FALLBACK, error: "No file provided." }, { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(FALLBACK);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    const dataUrl = isPdf
      ? `data:application/pdf;base64,${bytes.toString("base64")}`
      : `data:${file.type || "image/jpeg"};base64,${bytes.toString("base64")}`;

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the organization and treasurer information from this NYS foreign fire insurance filing.",
            },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<TaxProfileExtraction>;
    return NextResponse.json({ ...FALLBACK, ...parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error";
    return NextResponse.json({ ...FALLBACK, error: `Extraction failed: ${message}` });
  }
}
