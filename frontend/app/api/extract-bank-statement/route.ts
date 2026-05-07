import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

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
  const statementInputs = await parseStatementInputs(request);
  if (!statementInputs.length) return NextResponse.json({ ...FALLBACK, notes: "Upload a bank statement image or PDF." }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return NextResponse.json(FALLBACK);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const partials: Partial<BankStatementExtraction>[] = [];
    for (let index = 0; index < statementInputs.length; index += 1) {
      const statement = statementInputs[index]!;
      const isPdf = statement.contentType === "application/pdf" || statement.filename.toLowerCase().endsWith(".pdf");
      const response = isPdf
        ? await extractFromPdfFile({
            client,
            bytes: statement.bytes,
            filename: statement.filename,
            fileLabel: `statement PDF ${index + 1} of ${statementInputs.length}`,
          })
        : await extractFromImage({
            client,
            dataUrl: `data:${statement.contentType || "application/octet-stream"};base64,${statement.bytes.toString("base64")}`,
            fileLabel: `statement image ${index + 1} of ${statementInputs.length}`,
          });
      const raw = (response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "{}";
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

async function parseStatementInputs(request: NextRequest) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as { statement_urls?: string[]; filenames?: string[] };
    const urls = payload.statement_urls || [];
    const names = payload.filenames || [];
    const fetched = await Promise.all(
      urls.map(async (url, index) => {
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return {
          bytes: Buffer.from(arrayBuffer),
          contentType: response.headers.get("content-type") || "application/octet-stream",
          filename: names[index] || `statement-${index + 1}`,
        };
      }),
    );
    return fetched.filter(Boolean) as Array<{ bytes: Buffer; contentType: string; filename: string }>;
  }

  const formData = await request.formData();
  const statements = formData.getAll("statements").filter((entry): entry is File => entry instanceof File);
  if (!statements.length) {
    const single = formData.get("statement");
    if (single instanceof File) statements.push(single);
  }
  const loaded = await Promise.all(
    statements.map(async (statement, index) => ({
      bytes: Buffer.from(await statement.arrayBuffer()),
      contentType: statement.type || "application/octet-stream",
      filename: statement.name || `statement-${index + 1}`,
    })),
  );
  return loaded;
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

async function extractFromPdfFile({
  client,
  bytes,
  filename,
  fileLabel,
}: {
  client: OpenAI;
  bytes: Buffer;
  filename: string;
  fileLabel: string;
}) {
  const file = await toFile(bytes, filename, { type: "application/pdf" });
  const uploaded = await client.files.create({
    file,
    purpose: "assistants",
  });
  try {
    const responseApi = (client as unknown as {
      responses?: {
        create: (args: Record<string, unknown>) => Promise<{ output_text?: string }>;
      };
    }).responses;
    if (responseApi?.create) {
      const response = await responseApi.create({
        model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
        temperature: 0,
        input: [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: [
              { type: "input_text", text: `Extract transactions and balances from ${fileLabel}.` },
              { type: "input_file", file_id: uploaded.id },
            ],
          },
        ],
      });
      const raw = response.output_text || "{}";
      return {
        choices: [{ message: { content: raw } }],
      } as unknown as Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;
    }
  } finally {
    await client.files.delete(uploaded.id).catch(() => undefined);
  }

  const dataUrl = `data:application/pdf;base64,${bytes.toString("base64")}`;
  return extractFromImage({ client, dataUrl, fileLabel });
}

