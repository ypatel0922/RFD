import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

export type OnboardingExtractionResult = {
  accounts: string[];
  categories: string[];
  vendors: string[];
  income_types: string[];
  confidence: number;
  notes: string | null;
};

const FALLBACK: OnboardingExtractionResult = {
  accounts: [],
  categories: [],
  vendors: [],
  income_types: [],
  confidence: 0,
  notes: "Configure OPENAI_API_KEY to enable automatic extraction from uploaded records.",
};

const SYSTEM_PROMPT = `You are analyzing an old financial record — such as a handwritten bank register, treasurer notebook, check log, deposit register, or spreadsheet — for a fire department or similar organization.

Your job is to identify:
1. Account names (e.g. "Balance Fund", "2% Fund", "Operating Checking", "Cash Account")
2. Category names (e.g. "Banquet", "Insurance", "Supplies", "Training", "Equipment", "Dues", "Food", "Donations")
3. Vendor or payee names (e.g. "Capo Restaurant", "Subway", "LIDL", "Dunkin", "Insurance Co")
4. Income types (e.g. "Member dues", "Interest", "2% deposit", "Donations", "Fundraising income")

Return ONLY valid JSON with this exact shape:
{
  "accounts": ["string"],
  "categories": ["string"],
  "vendors": ["string"],
  "income_types": ["string"],
  "confidence": 0.0-1.0,
  "notes": "string or null"
}

Rules:
- Only include items that appear in the document. Do not invent or guess values not present.
- Return clean, title-cased names (e.g. "Operating Checking" not "operating checking").
- Remove duplicates.
- If the document is unclear or unreadable, return empty arrays with low confidence.
- Do NOT return transaction data. Do NOT include dates, amounts, or check numbers.
- This data is for onboarding setup only — it will not be automatically added to any ledger.`;

export async function POST(request: NextRequest) {
  const input = await parseInput(request);
  if (!input) {
    return NextResponse.json(
      { ...FALLBACK, notes: "Provide a file_url or multipart file upload." },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(FALLBACK);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const raw = await extractFromInput(client, input);
    const parsed = parseResult(raw);
    return NextResponse.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction error";
    return NextResponse.json({
      ...FALLBACK,
      notes: `Extraction failed: ${message}`,
    });
  }
}

type ExtractionInput = {
  bytes: Buffer;
  contentType: string;
  filename: string;
};

async function parseInput(request: NextRequest): Promise<ExtractionInput | null> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      file_url?: string;
      filename?: string;
      content_type?: string;
    };
    if (!body.file_url) return null;
    const res = await fetch(body.file_url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return {
      bytes: Buffer.from(arrayBuffer),
      contentType: body.content_type || res.headers.get("content-type") || "application/octet-stream",
      filename: body.filename || "record",
    };
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return null;
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type || "application/octet-stream",
    filename: file.name || "record",
  };
}

async function extractFromInput(client: OpenAI, input: ExtractionInput): Promise<string> {
  const isPdf =
    input.contentType === "application/pdf" ||
    input.filename.toLowerCase().endsWith(".pdf");

  const isCsvOrXlsx =
    input.contentType.includes("spreadsheet") ||
    input.contentType.includes("csv") ||
    input.contentType === "text/csv" ||
    input.filename.toLowerCase().endsWith(".csv") ||
    input.filename.toLowerCase().endsWith(".xlsx") ||
    input.filename.toLowerCase().endsWith(".xls");

  if (isCsvOrXlsx) {
    return extractFromText(client, input.bytes.toString("utf-8"), input.filename);
  }

  if (isPdf) {
    return extractFromPdf(client, input.bytes, input.filename);
  }

  const dataUrl = `data:${input.contentType};base64,${input.bytes.toString("base64")}`;
  return extractFromImage(client, dataUrl, input.filename);
}

async function extractFromImage(client: OpenAI, dataUrl: string, filename: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Extract setup information from this financial record: "${filename}"` },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  });
  return response.choices[0]?.message?.content || "{}";
}

async function extractFromPdf(client: OpenAI, bytes: Buffer, filename: string): Promise<string> {
  const file = await toFile(bytes, filename, { type: "application/pdf" });
  const uploaded = await client.files.create({ file, purpose: "assistants" });
  try {
    const responseApi = (client as unknown as {
      responses?: { create: (args: Record<string, unknown>) => Promise<{ output_text?: string }> };
    }).responses;

    if (responseApi?.create) {
      const response = await responseApi.create({
        model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
        temperature: 0,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "input_text", text: `Extract setup information from this financial record: "${filename}"` },
              { type: "input_file", file_id: uploaded.id },
            ],
          },
        ],
      });
      return response.output_text || "{}";
    }
  } finally {
    await client.files.delete(uploaded.id).catch(() => undefined);
  }

  const dataUrl = `data:application/pdf;base64,${bytes.toString("base64")}`;
  return extractFromImage(client, dataUrl, filename);
}

async function extractFromText(client: OpenAI, text: string, filename: string): Promise<string> {
  const truncated = text.slice(0, 12000);
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Extract setup information from this spreadsheet/CSV: "${filename}"\n\n${truncated}`,
      },
    ],
  });
  return response.choices[0]?.message?.content || "{}";
}

function parseResult(raw: string): OnboardingExtractionResult {
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingExtractionResult>;
    return {
      accounts: toStringArray(parsed.accounts),
      categories: toStringArray(parsed.categories),
      vendors: toStringArray(parsed.vendors),
      income_types: toStringArray(parsed.income_types),
      confidence: clampConfidence(parsed.confidence),
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
    };
  } catch {
    return { ...FALLBACK, notes: "Could not parse extraction result." };
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
