/**
 * Strict schema for a single statement page read by the vision model.
 *
 * Two layers on purpose:
 *
 *  1. `STATEMENT_PAGE_JSON_SCHEMA` is sent to the provider as a structured-output
 *     contract so the model is constrained while generating.
 *  2. `rawPageSchema` re-validates whatever actually came back. The provider is
 *     untrusted input: a model can return the right shape with wrong types, or
 *     a provider can quietly fall back to free-form JSON.
 *
 * Amounts and dates arrive as raw printed strings and are normalized afterwards
 * by deterministic code (`normalizePageExtraction`) rather than trusting the
 * model to do arithmetic or date maths.
 */

import { z } from "zod";

import { normalizeStatementDate } from "./dates";
import {
  extractCheckNumber,
  normalizeCheckNumber,
  normalizeDescription,
  normalizeReferenceNumber,
} from "./description";
import { absCents, parseCents, type Cents } from "./money";
import type { ExtractedPageHeader, ExtractedPageLine, PageExtractionResult } from "./types";

/** JSON Schema handed to the provider. Every field is required and nullable so
 * the model must decide explicitly rather than omitting a field it cannot read. */
export const STATEMENT_PAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["page", "transactions"],
  properties: {
    page: {
      type: "object",
      additionalProperties: false,
      required: [
        "financial_institution",
        "account_type",
        "account_holder",
        "account_last_four",
        "statement_start_date",
        "statement_end_date",
        "beginning_balance",
        "ending_balance",
        "total_deposits_credits",
        "total_withdrawals_debits",
        "printed_page_number",
        "printed_page_count",
        "section_headings",
        "page_warnings",
      ],
      properties: {
        financial_institution: { type: ["string", "null"] },
        account_type: { type: ["string", "null"] },
        account_holder: { type: ["string", "null"] },
        account_last_four: {
          type: ["string", "null"],
          description: "Only the final four digits. Never the full account number.",
        },
        statement_start_date: { type: ["string", "null"] },
        statement_end_date: { type: ["string", "null"] },
        beginning_balance: { type: ["string", "null"] },
        ending_balance: { type: ["string", "null"] },
        total_deposits_credits: { type: ["string", "null"] },
        total_withdrawals_debits: { type: ["string", "null"] },
        printed_page_number: { type: ["integer", "null"] },
        printed_page_count: { type: ["integer", "null"] },
        section_headings: { type: "array", items: { type: "string" } },
        page_warnings: { type: "array", items: { type: "string" } },
      },
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "row_order",
          "posted_date",
          "transaction_date",
          "description",
          "debit_amount",
          "credit_amount",
          "amount",
          "check_number",
          "reference_number",
          "running_balance",
          "section_heading",
          "is_pending",
          "is_continuation_of_previous_row",
          "confidence",
          "warning",
        ],
        properties: {
          row_order: { type: "integer" },
          posted_date: { type: ["string", "null"] },
          transaction_date: { type: ["string", "null"] },
          description: { type: "string" },
          debit_amount: { type: ["string", "null"] },
          credit_amount: { type: ["string", "null"] },
          amount: {
            type: ["string", "null"],
            description:
              "Single signed amount when the statement has one amount column instead of separate debit/credit columns. Prefer debit_amount/credit_amount when both columns exist.",
          },
          check_number: { type: ["string", "null"] },
          reference_number: { type: ["string", "null"] },
          running_balance: { type: ["string", "null"] },
          section_heading: { type: ["string", "null"] },
          is_pending: { type: "boolean" },
          is_continuation_of_previous_row: { type: "boolean" },
          confidence: { type: "number" },
          warning: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const nullableText = z.union([z.string(), z.number()]).nullable().optional();
const nullableInt = z.union([z.number(), z.string()]).nullable().optional();

const rawTransactionSchema = z.object({
  row_order: nullableInt,
  posted_date: nullableText,
  transaction_date: nullableText,
  description: z.union([z.string(), z.number()]).nullable().optional(),
  debit_amount: nullableText,
  credit_amount: nullableText,
  /** Single amount column — accepted when debit/credit were not filled. */
  amount: nullableText,
  check_number: nullableText,
  reference_number: nullableText,
  running_balance: nullableText,
  section_heading: nullableText,
  is_pending: z.boolean().nullable().optional(),
  is_continuation_of_previous_row: z.boolean().nullable().optional(),
  confidence: z.union([z.number(), z.string()]).nullable().optional(),
  warning: nullableText,
});

const rawPageHeaderSchema = z.object({
  financial_institution: nullableText,
  account_type: nullableText,
  account_holder: nullableText,
  account_last_four: nullableText,
  statement_start_date: nullableText,
  statement_end_date: nullableText,
  beginning_balance: nullableText,
  ending_balance: nullableText,
  total_deposits_credits: nullableText,
  total_withdrawals_debits: nullableText,
  printed_page_number: nullableInt,
  printed_page_count: nullableInt,
  section_headings: z.array(z.union([z.string(), z.number()])).nullable().optional(),
  page_warnings: z.array(z.union([z.string(), z.number()])).nullable().optional(),
});

export const rawPageSchema = z.object({
  page: rawPageHeaderSchema.nullable().optional(),
  transactions: z.array(rawTransactionSchema).nullable().optional(),
});

export type RawPageExtraction = z.infer<typeof rawPageSchema>;

export class ExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

/** Parse and validate an untrusted provider response. */
export function parseRawPage(payload: unknown): RawPageExtraction {
  const result = rawPageSchema.safeParse(payload);
  if (!result.success) {
    // The issue path is safe to surface internally; it names fields, not values.
    const first = result.error.issues[0];
    throw new ExtractionValidationError(
      `Statement page response did not match the expected shape at "${first?.path.join(".") || "root"}".`,
    );
  }
  return result.data;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function integer(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/[^\d-]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  return rounded > 0 && rounded < 1000 ? rounded : null;
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

/** Keep only the last four digits, whatever the model returned. */
function lastFour(value: unknown): string | null {
  const digits = text(value)?.replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-4);
}

/**
 * Turn a validated raw response into normalized page output.
 *
 * The debit/credit columns are the source of truth for direction. When a page
 * only reports one signed `amount`-like value the sign is taken from that value.
 * Nothing is invented: an unreadable amount stays null and carries a warning.
 */
export function normalizePageExtraction({
  raw,
  pageNumber,
  model,
}: {
  raw: RawPageExtraction;
  pageNumber: number;
  model: string;
}): PageExtractionResult {
  const rawHeader = raw.page ?? {};
  const warnings: string[] = [];

  for (const warning of rawHeader.page_warnings ?? []) {
    const value = text(warning);
    if (value) warnings.push(value);
  }

  const statementStartDate = normalizeStatementDate(rawHeader.statement_start_date);
  const statementEndDate = normalizeStatementDate(rawHeader.statement_end_date);
  // Rows usually print MM/DD with no year; resolve against the statement period.
  const referenceYear = Number(
    (statementEndDate ?? statementStartDate ?? "").slice(0, 4) || Number.NaN,
  );
  const yearHint = Number.isFinite(referenceYear) ? referenceYear : undefined;

  const header: ExtractedPageHeader = {
    financialInstitution: text(rawHeader.financial_institution),
    accountType: text(rawHeader.account_type),
    accountHolder: text(rawHeader.account_holder),
    accountLastFour: lastFour(rawHeader.account_last_four),
    statementStartDate,
    statementEndDate,
    beginningBalanceCents: parseCents(text(rawHeader.beginning_balance)),
    endingBalanceCents: parseCents(text(rawHeader.ending_balance)),
    totalCreditsCents: nonNegative(parseCents(text(rawHeader.total_deposits_credits))),
    totalDebitsCents: nonNegative(parseCents(text(rawHeader.total_withdrawals_debits))),
    printedPageNumber: integer(rawHeader.printed_page_number),
    printedPageCount: integer(rawHeader.printed_page_count),
    sectionHeadings: (rawHeader.section_headings ?? [])
      .map((value) => text(value))
      .filter((value): value is string => Boolean(value)),
  };

  const lines: ExtractedPageLine[] = [];
  const rawTransactions = raw.transactions ?? [];

  for (const [index, rawLine] of rawTransactions.entries()) {
    const originalDescription = text(rawLine.description) ?? "";
    const debitRaw = parseCents(text(rawLine.debit_amount));
    const creditRaw = parseCents(text(rawLine.credit_amount));
    const singleAmountRaw = parseCents(text(rawLine.amount));

    let signedAmountCents: Cents | null = null;
    let debitAmountCents: Cents | null = null;
    let creditAmountCents: Cents | null = null;
    let warning = text(rawLine.warning);

    if (debitRaw != null && creditRaw != null && debitRaw !== 0 && creditRaw !== 0) {
      // Both columns filled is a misread of a two-column layout. Keep both and
      // warn rather than guessing which one is real.
      debitAmountCents = absCents(debitRaw);
      creditAmountCents = absCents(creditRaw);
      warning =
        warning ??
        "Both a withdrawal and a deposit amount were read on this row. Check the amount against the statement.";
    } else if (debitRaw != null && debitRaw !== 0) {
      debitAmountCents = absCents(debitRaw);
      signedAmountCents = -debitAmountCents;
    } else if (creditRaw != null && creditRaw !== 0) {
      creditAmountCents = absCents(creditRaw);
      signedAmountCents = creditAmountCents;
    } else if (singleAmountRaw != null && singleAmountRaw !== 0) {
      // One-column statements (and json_object fallbacks) often return a single
      // signed amount instead of debit/credit. Preserve that rather than dropping
      // the row in consolidation.
      if (singleAmountRaw < 0) {
        debitAmountCents = absCents(singleAmountRaw);
        signedAmountCents = -debitAmountCents;
      } else {
        creditAmountCents = absCents(singleAmountRaw);
        signedAmountCents = creditAmountCents;
      }
    } else if (
      text(rawLine.debit_amount) == null &&
      text(rawLine.credit_amount) == null &&
      text(rawLine.amount) == null &&
      !rawLine.is_continuation_of_previous_row
    ) {
      warning =
        warning ??
        "No amount was read for this row. Check the statement and correct it if needed.";
    }

    const checkNumber =
      normalizeCheckNumber(text(rawLine.check_number)) ?? extractCheckNumber(originalDescription);

    lines.push({
      postedDate: normalizeStatementDate(rawLine.posted_date, yearHint),
      transactionDate: normalizeStatementDate(rawLine.transaction_date, yearHint),
      originalDescription,
      normalizedDescription: normalizeDescription(originalDescription),
      debitAmountCents,
      creditAmountCents,
      signedAmountCents,
      checkNumber,
      referenceNumber: normalizeReferenceNumber(text(rawLine.reference_number)),
      runningBalanceCents: parseCents(text(rawLine.running_balance)),
      pageNumber,
      rowNumber: integer(rawLine.row_order) ?? index + 1,
      sectionHeading: text(rawLine.section_heading),
      isPending: rawLine.is_pending === true,
      isContinuation: rawLine.is_continuation_of_previous_row === true,
      extractionConfidence: confidence(rawLine.confidence),
      extractionWarning: warning,
    });
  }

  if (!lines.length) {
    warnings.push("No transaction rows were read from this page.");
  }

  return { header, lines, warnings, model };
}

function nonNegative(cents: Cents | null): Cents | null {
  return cents == null ? null : absCents(cents);
}
