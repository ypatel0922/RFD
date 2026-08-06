/**
 * Server-only vision provider for statement page extraction.
 *
 * THIRD-PARTY PROCESSING NOTICE
 * -----------------------------
 * Statement page images are sent to OpenAI for text extraction. They are sent
 * from the server only -- the API key never reaches the browser -- and Hallix
 * does not store the image or the base64 payload anywhere. The bytes live in the
 * request handler's memory for the duration of one extraction call and are
 * released when it returns. Only the structured rows (dates, descriptions,
 * amounts) are persisted. Account numbers are reduced to the last four digits by
 * the extraction prompt and schema.
 *
 * The provider is chosen at runtime by `BANK_STATEMENT_VISION_MODEL` so the model
 * can be upgraded, pinned, or swapped without a code change.
 */

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { statementVisionModel } from "../config";
import { STATEMENT_PAGE_JSON_SCHEMA } from "../extraction-schema";

export class VisionProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "VisionProviderError";
    this.retryable = retryable;
  }
}

export const STATEMENT_PAGE_PROMPT = `You transcribe one page of a bank statement for a fire department's bookkeeping system.

Read the page exactly as printed, top to bottom, in visible row order. Accuracy matters far more than completeness of interpretation: this transcription is used to prove that a statement balances.

RULES
- Include EVERY posted transaction line visible on this page. Prefer a row with a null amount and a short warning over omitting the row.
- Never invent a value. If a field is not visible or you cannot read it confidently, return null and put a short explanation in "warning" for that row (or in "page_warnings" for the page).
- Return only the LAST FOUR DIGITS of the account number in account_last_four. Never return a full account number anywhere.
- Copy "description" exactly as printed, including punctuation and reference text.
- Use the statement's own columns to decide direction:
  * A withdrawal, debit, check, fee, or payment goes in "debit_amount".
  * A deposit, credit, interest payment, or refund goes in "credit_amount".
  * Exactly one of debit_amount / credit_amount must be set per transaction row when the statement has separate columns.
  * If the statement uses one signed amount column, put the printed value in "amount" (negative or parenthesised values are withdrawals) and leave debit_amount/credit_amount null.
- Amounts are the printed digits without a currency symbol, e.g. "1,204.55" or "1204.55".
- Dates: return them exactly as printed (for example "04/12" or "2026-04-12"). Do not convert or guess a year.
- "running_balance" is the balance printed on that row, if the statement shows one. Otherwise null.
- "check_number" is the check number printed for that row, if any.
- "reference_number" is a visible ACH trace, card authorisation, wire reference, deposit ticket, or confirmation number.

WHAT IS NOT A TRANSACTION ROW
Do not return these as transactions:
- Page headers and column titles repeated at the top of a page.
- Beginning balance, opening balance, previous balance.
- Ending balance, closing balance, new balance.
- Balance forward, balance brought forward, balance carried forward.
- Subtotal and total rows ("Total deposits", "Total withdrawals").
- "Continued on next page" / "Continued from previous page".
- Daily balance summaries, interest summaries, year-to-date boxes, marketing text.
Instead, put beginning/ending balances and the deposit/withdrawal totals in the "page" object.

WRAPPED DESCRIPTIONS
When a description wraps onto a second printed line, return that second line as its own transaction entry with is_continuation_of_previous_row set to true, all amounts null, and both dates null. Do not merge it yourself and do not duplicate the amount.

PENDING TRANSACTIONS
Set is_pending to true for rows in a "pending" or "not yet posted" section. Pending rows are not part of the statement's balance.

CONFIDENCE
Set "confidence" between 0 and 1 for each row based on how legibly you could read every field on it.

If this page has no transaction list at all (for example it is a page of disclosures), return an empty transactions array and describe the page in page_warnings.`;

export type ExtractPageRequest = {
  bytes: Buffer;
  mimeType: string;
  /** 1-based position in the statement, used only for the prompt hint. */
  pageNumber: number;
  totalPages: number;
};

export type VisionProvider = {
  readonly model: string;
  extractPage(request: ExtractPageRequest): Promise<unknown>;
};

/** True when extraction is possible at all in this environment. */
export function isVisionProviderConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function createVisionProvider(): VisionProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new VisionProviderError("Statement reading is not configured on this server.", false);
  }
  const model = statementVisionModel();
  // maxRetries: 0 — the browser already retries a failed page. Letting the SDK
  // retry 429s here turns a quick failure into a 20s hang that still ends as
  // "busy", which is what treasurers just saw locally.
  const client = new OpenAI({ apiKey, maxRetries: 0 });

  return {
    model,
    async extractPage(request) {
      const isPdf =
        request.mimeType === "application/pdf" ||
        request.bytes.subarray(0, 5).toString("latin1") === "%PDF-";

      const userHint = `This is page ${request.pageNumber} of ${request.totalPages} that the treasurer photographed or selected. Transcribe only what is visible on this page.`;

      const raw = isPdf
        ? await extractFromPdf({ client, model, request, userHint })
        : await extractFromImage({ client, model, request, userHint });

      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new VisionProviderError("The statement reader returned a response we could not read.");
      }
    },
  };
}

const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "bank_statement_page",
    strict: true,
    schema: STATEMENT_PAGE_JSON_SCHEMA,
  },
};

async function extractFromImage({
  client,
  model,
  request,
  userHint,
}: {
  client: OpenAI;
  model: string;
  request: ExtractPageRequest;
  userHint: string;
}): Promise<string> {
  const dataUrl = `data:${request.mimeType || "image/jpeg"};base64,${request.bytes.toString("base64")}`;

  const call = (useStructuredSchema: boolean) =>
    client.chat.completions.create({
      model,
      temperature: 0,
      response_format: useStructuredSchema ? RESPONSE_FORMAT : { type: "json_object" },
      messages: [
        { role: "system", content: STATEMENT_PAGE_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userHint },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });

  let response;
  try {
    response = await call(true);
  } catch (error) {
    // Older or restricted deployments reject a json_schema response format.
    // Fall back to plain JSON mode; the Zod layer still validates the result.
    if (!isSchemaUnsupportedError(error)) throw toProviderError(error);
    try {
      response = await call(false);
    } catch (fallbackError) {
      throw toProviderError(fallbackError);
    }
  }

  const content = response.choices[0]?.message?.content;
  if (!content) throw new VisionProviderError("The statement reader returned an empty response.");
  return content;
}

/**
 * A PDF page is handed to the provider as a file rather than an image so text-based
 * statements keep their crisp text layer. The uploaded file is deleted in a
 * `finally` block, including on the error path, so no copy of the statement is
 * left with the provider.
 */
async function extractFromPdf({
  client,
  model,
  request,
  userHint,
}: {
  client: OpenAI;
  model: string;
  request: ExtractPageRequest;
  userHint: string;
}): Promise<string> {
  const file = await toFile(request.bytes, `statement-page-${request.pageNumber}.pdf`, {
    type: "application/pdf",
  });
  let uploadedId: string | null = null;
  try {
    // Match the purpose used by the existing extract-bank-statement route.
    // `user_data` is newer and not available on every account; a 400 from it
    // was previously swallowed into a generic failure.
    const uploaded = await client.files.create({ file, purpose: "assistants" });
    uploadedId = uploaded.id;

    const responseApi = (
      client as unknown as {
        responses?: {
          create: (args: Record<string, unknown>) => Promise<{ output_text?: string }>;
        };
      }
    ).responses;

    if (responseApi?.create) {
      try {
        const response = await responseApi.create({
          model,
          temperature: 0,
          instructions: STATEMENT_PAGE_PROMPT,
          text: {
            format: {
              type: "json_schema",
              name: "bank_statement_page",
              strict: true,
              schema: STATEMENT_PAGE_JSON_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: userHint },
                { type: "input_file", file_id: uploaded.id },
              ],
            },
          ],
        });
        const text = response.output_text;
        if (!text) throw new VisionProviderError("The statement reader returned an empty response.");
        return text;
      } catch (error) {
        // If the Responses API rejects the PDF (common on older accounts), fall
        // back to sending the PDF as a data URL through chat completions — the
        // same path the legacy statement extractor uses as its last resort.
        if (!isPdfInputUnsupportedError(error)) throw toProviderError(error);
      }
    }

    return extractFromImage({
      client,
      model,
      request: { ...request, mimeType: "application/pdf" },
      userHint,
    });
  } catch (error) {
    throw toProviderError(error);
  } finally {
    if (uploadedId) {
      await client.files.delete(uploadedId).catch(() => undefined);
    }
  }
}

function isSchemaUnsupportedError(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== 400) return false;
  const message = providerMessage(error).toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_schema") ||
    message.includes("structured output")
  );
}

function isPdfInputUnsupportedError(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== 400) return false;
  const message = providerMessage(error).toLowerCase();
  return (
    message.includes("input_file") ||
    message.includes("file_id") ||
    message.includes("pdf") ||
    message.includes("unsupported") ||
    message.includes("invalid_request")
  );
}

/**
 * Convert a provider error into something safe to bubble up. Provider messages
 * can echo request content, so nothing from them is preserved for the browser.
 * Status and error code are logged so a local failure is diagnosable.
 */
function toProviderError(error: unknown): VisionProviderError {
  if (error instanceof VisionProviderError) return error;

  const status = providerStatus(error);
  const code = providerCode(error);
  const message = providerMessage(error);

  // Safe diagnostics only: never the request body, image bytes, or account data.
  console.error(
    `[reconciliation] vision provider failed — status=${status ?? "none"} code=${code ?? "none"} message=${message.slice(0, 180)}`,
  );

  if (status === 401 || status === 403) {
    return new VisionProviderError("Statement reading is not configured on this server.", false);
  }

  if (status === 429 || code === "rate_limit_exceeded" || code === "insufficient_quota" || code === "credit_balance_exhausted") {
    if (
      code === "insufficient_quota" ||
      code === "credit_balance_exhausted" ||
      /quota|billing|credit|exceeded your current/i.test(message)
    ) {
      return new VisionProviderError(
        "Statement reading has no remaining OpenAI credit. Check the API key's billing and quota, then try again.",
        false,
      );
    }
    return new VisionProviderError("The statement reader is busy. Try this page again in a moment.");
  }

  if (status === 404 || code === "model_not_found") {
    return new VisionProviderError(
      "The statement reading model is not available for this API key. Set BANK_STATEMENT_VISION_MODEL to a vision model your account can use (for example gpt-4o or gpt-4o-mini).",
      false,
    );
  }

  if (status === 413) {
    return new VisionProviderError("That page image is too large to read. Retake it and try again.");
  }

  return new VisionProviderError("This page could not be read. Try a clearer photo of the page.");
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function providerCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function providerMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}
