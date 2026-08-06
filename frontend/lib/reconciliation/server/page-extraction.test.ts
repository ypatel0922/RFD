/**
 * Pass 1 with a mocked vision provider.
 *
 * The provider is always mocked here: these tests must be deterministic and must
 * never send anything to a third party.
 */

import { describe, expect, it, vi } from "vitest";

import { normalizePageExtraction, parseRawPage, ExtractionValidationError } from "../extraction-schema";
import { digestPageBytes, extractStatementPage } from "./page-extraction";
import { VisionProviderError, type VisionProvider } from "./vision-provider";

/** A 2x2 PNG header with dimensions the inspector accepts. */
function fakePng(width = 1700, height = 2200, salt = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13);
  const ihdrType = Buffer.from("IHDR");
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  const rest = Buffer.alloc(5 + 64, salt);
  return Buffer.concat([signature, ihdrLength, ihdrType, dimensions, rest]);
}

function providerReturning(payload: unknown, model = "test-vision-model"): VisionProvider {
  return { model, extractPage: vi.fn().mockResolvedValue(payload) };
}

const GOOD_PAGE = {
  page: {
    financial_institution: "Cedar Hollow Community Bank",
    account_type: "Business Checking",
    account_holder: "Cedar Hollow Fire District",
    account_last_four: "4417",
    statement_start_date: "03/01/2025",
    statement_end_date: "03/31/2025",
    beginning_balance: "$5,000.00",
    ending_balance: "$5,600.00",
    total_deposits_credits: "$1,000.00",
    total_withdrawals_debits: "$400.00",
    printed_page_number: 1,
    printed_page_count: 2,
    section_headings: ["Deposits and Other Credits"],
    page_warnings: [],
  },
  transactions: [
    {
      row_order: 1,
      posted_date: "03/03",
      transaction_date: null,
      description: "DEPOSIT TOWN SHARE",
      debit_amount: null,
      credit_amount: "1,000.00",
      check_number: null,
      reference_number: null,
      running_balance: "6,000.00",
      section_heading: "Deposits and Other Credits",
      is_pending: false,
      is_continuation_of_previous_row: false,
      confidence: 0.97,
      warning: null,
    },
    {
      row_order: 2,
      posted_date: "03/11",
      transaction_date: null,
      description: "CHECK 2087",
      debit_amount: "250.00",
      credit_amount: null,
      check_number: "2087",
      reference_number: null,
      running_balance: "5,750.00",
      section_heading: null,
      is_pending: false,
      is_continuation_of_previous_row: false,
      confidence: 0.95,
      warning: null,
    },
  ],
};

describe("page extraction with a mocked provider", () => {
  it("normalizes dates, signs and amounts from the printed strings", async () => {
    const outcome = await extractStatementPage({
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 2,
      provider: providerReturning(GOOD_PAGE),
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;

    expect(outcome.result.header.beginningBalanceCents).toBe(500_000);
    expect(outcome.result.header.statementStartDate).toBe("2025-03-01");
    // MM/DD rows take their year from the statement period.
    expect(outcome.result.lines[0].postedDate).toBe("2025-03-03");
    expect(outcome.result.lines[0].signedAmountCents).toBe(100_000);
    expect(outcome.result.lines[1].signedAmountCents).toBe(-25_000);
    expect(outcome.result.lines[1].checkNumber).toBe("2087");
  });

  it("only ever keeps the last four digits of an account number", () => {
    const result = normalizePageExtraction({
      raw: parseRawPage({
        page: { ...GOOD_PAGE.page, account_last_four: "1234567890124417" },
        transactions: [],
      }),
      pageNumber: 1,
      model: "test-vision-model",
    });

    expect(result.header.accountLastFour).toBe("4417");
  });
});

describe("scenario 19 — low-confidence or unreadable amount", () => {
  it("keeps the row with a null amount and the model's warning rather than inventing a value", () => {
    const result = normalizePageExtraction({
      raw: parseRawPage({
        page: GOOD_PAGE.page,
        transactions: [
          {
            row_order: 1,
            posted_date: "03/14",
            description: "SMUDGED VENDOR NAME",
            debit_amount: null,
            credit_amount: null,
            check_number: null,
            reference_number: null,
            running_balance: null,
            section_heading: null,
            is_pending: false,
            is_continuation_of_previous_row: false,
            confidence: 0.22,
            warning: "The amount column is obscured on this row.",
          },
        ],
      }),
      pageNumber: 1,
      model: "test-vision-model",
    });

    expect(result.lines[0].signedAmountCents).toBeNull();
    expect(result.lines[0].extractionConfidence).toBeCloseTo(0.22);
    expect(result.lines[0].extractionWarning).toBe("The amount column is obscured on this row.");
  });

  it("warns instead of guessing when both amount columns are filled", () => {
    const result = normalizePageExtraction({
      raw: parseRawPage({
        page: GOOD_PAGE.page,
        transactions: [
          {
            row_order: 1,
            posted_date: "03/14",
            description: "AMBIGUOUS COLUMNS",
            debit_amount: "40.00",
            credit_amount: "40.00",
            check_number: null,
            reference_number: null,
            running_balance: null,
            section_heading: null,
            is_pending: false,
            is_continuation_of_previous_row: false,
            confidence: 0.6,
            warning: null,
          },
        ],
      }),
      pageNumber: 1,
      model: "test-vision-model",
    });

    expect(result.lines[0].signedAmountCents).toBeNull();
    expect(result.lines[0].extractionWarning).toContain("withdrawal and a deposit");
  });
});

describe("provider responses that cannot be trusted", () => {
  it("rejects a response of the wrong shape", () => {
    expect(() => parseRawPage({ transactions: "not an array" })).toThrow(ExtractionValidationError);
  });

  it("turns a malformed response into a retryable page failure, not a crash", async () => {
    const outcome = await extractStatementPage({
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 1,
      provider: providerReturning({ transactions: 42 }),
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.retryable).toBe(true);
    expect(outcome.reason).not.toContain("zod");
  });

  it("passes the provider's own plain-language message through without internals", async () => {
    const provider: VisionProvider = {
      model: "test-vision-model",
      extractPage: vi
        .fn()
        .mockRejectedValue(
          new VisionProviderError("The statement reader is busy. Try this page again in a moment.", true),
        ),
    };

    const outcome = await extractStatementPage({
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 1,
      provider,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("The statement reader is busy. Try this page again in a moment.");
  });

  it("reports an empty read as needing a clearer photo", async () => {
    const outcome = await extractStatementPage({
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 1,
      provider: providerReturning({ page: null, transactions: [] }),
    });

    expect(outcome.status).toBe("unreadable");
  });

  it("treats a header-only page with no transactions as incomplete", async () => {
    const outcome = await extractStatementPage({
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 2,
      provider: providerReturning({
        page: {
          ...GOOD_PAGE.page,
        },
        transactions: [],
      }),
    });

    expect(outcome.status).toBe("unreadable");
    if (outcome.status !== "unreadable") return;
    expect(outcome.reason).toContain("no transactions");
  });

  it("accepts a single amount column when debit/credit are empty", () => {
    const result = normalizePageExtraction({
      raw: parseRawPage({
        page: GOOD_PAGE.page,
        transactions: [
          {
            row_order: 1,
            posted_date: "03/14",
            description: "ONE COLUMN WITHDRAWAL",
            debit_amount: null,
            credit_amount: null,
            amount: "-45.00",
            check_number: null,
            reference_number: null,
            running_balance: null,
            section_heading: null,
            is_pending: false,
            is_continuation_of_previous_row: false,
            confidence: 0.9,
            warning: null,
          },
        ],
      }),
      pageNumber: 1,
      model: "test-vision-model",
    });

    expect(result.lines[0].signedAmountCents).toBe(-4_500);
    expect(result.lines[0].debitAmountCents).toBe(4_500);
  });
});

describe("image quality gate", () => {
  it("rejects an image too small to resolve statement text before calling the provider", async () => {
    const provider = providerReturning(GOOD_PAGE);
    const outcome = await extractStatementPage({
      bytes: fakePng(120, 90),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 1,
      provider,
    });

    expect(outcome.status).toBe("unreadable");
    expect(provider.extractPage).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not an image or PDF at all", async () => {
    const provider = providerReturning(GOOD_PAGE);
    const outcome = await extractStatementPage({
      bytes: Buffer.from("this is not a photograph"),
      mimeType: "image/jpeg",
      pageNumber: 1,
      totalPages: 1,
      provider,
    });

    expect(outcome.status).toBe("unreadable");
    expect(provider.extractPage).not.toHaveBeenCalled();
  });
});

describe("scenario 22 — retry of the same page-processing request", () => {
  it("produces the same digest for the same bytes, so a retry replaces rather than duplicates", async () => {
    const bytes = fakePng();
    expect(await digestPageBytes(bytes)).toBe(await digestPageBytes(Buffer.from(bytes)));
  });

  it("gives different digests to different photos of the same page", async () => {
    expect(await digestPageBytes(fakePng(1700, 2200, 1))).not.toBe(
      await digestPageBytes(fakePng(1700, 2200, 2)),
    );
  });

  it("returns the same extraction when the identical page is submitted twice", async () => {
    const provider = providerReturning(GOOD_PAGE);
    const input = {
      bytes: fakePng(),
      mimeType: "image/png",
      pageNumber: 1,
      totalPages: 2,
      provider,
    };

    const first = await extractStatementPage(input);
    const second = await extractStatementPage(input);

    expect(first).toEqual(second);
    if (first.status !== "complete" || second.status !== "complete") return;
    expect(first.imageDigest).toBe(second.imageDigest);
  });
});
