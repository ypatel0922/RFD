import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import type { BankStatementExtraction } from "../../../lib/types";

const FALLBACK: BankStatementExtraction = {
  account_name: null,
  beginning_balance: null,
  ending_balance: null,
  statement_start_date: null,
  statement_end_date: null,
  transactions: [],
  confidence: 0,
  notes: "Statement uploaded. Configure OPENAI_API_KEY to auto-extract transactions.",
};

const PROMPT = `Extract bank statement data.
Return valid JSON only with keys:
account_name, beginning_balance, ending_balance, statement_start_date, statement_end_date, confidence, notes, transactions.
transactions must be an array of objects with keys:
posted_date, description, amount, balance, reference.
Dates use YYYY-MM-DD when visible. Amounts are numbers without currency symbols.
Read transaction/activity sections from all pages, not just page 1.`;

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const statements = formData.getAll("statements").filter((entry): entry is File => entry instanceof File);
  if (!statements.length) {
    const single = formData.get("statement");
    if (single instanceof File) {
      statements.push(single);
    }
  }
  if (!statements.length) {
    return NextResponse.json({ ...FALLBACK, notes: "Upload a bank statement image or PDF." }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) return NextResponse.json(FALLBACK);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const partials: Partial<BankStatementExtraction>[] = [];
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      const bytes = Buffer.from(await statement.arrayBuffer());
      const isPdf = statement.type === "application/pdf" || statement.name.toLowerCase().endsWith(".pdf");
      const response = await extractFromImage({
            client,
            dataUrl: `data:${statement.type || "application/octet-stream"};base64,${bytes.toString("base64")}`,
            fileLabel: `${isPdf ? "statement PDF" : "statement image"} ${index + 1} of ${statements.length}`,
          });
      const raw = response.choices[0]?.message.content || "{}";
      partials.push(JSON.parse(raw) as Partial<BankStatementExtraction>);
    }
    const payload = mergeExtractions(partials);
    return NextResponse.json({
      ...FALLBACK,
      ...payload,
      transactions: Array.isArray(payload.transactions) ? payload.transactions : [],
      confidence: clampConfidence(payload.confidence),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error";
    return NextResponse.json({ ...FALLBACK, notes: `Statement extraction failed: ${message}` });
  }
}

function clampConfidence(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function mergeExtractions(partials: Partial<BankStatementExtraction>[]) {
  const transactions = partials.flatMap((entry) => (Array.isArray(entry.transactions) ? entry.transactions : []));
  return {
    account_name: firstNonNull(partials.map((entry) => entry.account_name ?? null)),
    beginning_balance: firstNonNull(partials.map((entry) => entry.beginning_balance ?? null)),
    ending_balance: firstNonNull(partials.map((entry) => entry.ending_balance ?? null)),
    statement_start_date: firstNonNull(partials.map((entry) => entry.statement_start_date ?? null)),
    statement_end_date: firstNonNull(partials.map((entry) => entry.statement_end_date ?? null)),
    notes: firstNonNull(partials.map((entry) => entry.notes ?? null)),
    confidence:
      partials.length === 0
        ? 0
        : partials.reduce((total, entry) => total + clampConfidence(entry.confidence), 0) / partials.length,
    transactions,
  } satisfies Partial<BankStatementExtraction>;
}

function firstNonNull<T>(values: Array<T | null>) {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

async function extractFromImage({
  client,
  dataUrl,
  fileLabel,
}: {
  client: OpenAI;
  dataUrl: string;
  fileLabel: string;
}) {
  return client.chat.completions.create({
    model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Extract transactions and balances from ${fileLabel}.` },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  });
}

