/**
 * Receipt extraction with inline categorization.
 *
 * Categorization rides along in the existing OCR request, so the thing worth
 * pinning is that it can never break extraction: a bad category, a refused
 * model, or a thrown request must all still leave a usable receipt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

const { extractReceiptFromBuffer, FALLBACK_EXTRACTION } = await import("./extract-receipt-server");

const ALLOWED = ["Food", "Fuel", "Repairs & Maintenance"];
const IMAGE = Buffer.from("fake-image-bytes");

function reply(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

function receiptPayload(extra: Record<string, unknown> = {}) {
  return {
    merchant_name: "Chipotle",
    payee: "Chipotle",
    transaction_date: "2026-03-04",
    total_amount: "186.42",
    payment_reference: "AUTH 4821",
    confidence: 0.93,
    ...extra,
  };
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  createMock.mockReset();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("categorizing inside the extraction call", () => {
  it("returns the category alongside the receipt fields", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          line_items: ["burrito bowl", "chips & queso"],
          suggested_category: "Food",
          category_confidence: 0.94,
          category_reason: "Restaurant receipt with prepared food items",
          suggest_two_percent: true,
          two_percent_confidence: 0.81,
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result.merchant_name).toBe("Chipotle");
    expect(result.suggested_category).toBe("Food");
    expect(result.category_confidence).toBeCloseTo(0.94);
    expect(result.suggest_two_percent).toBe(true);
    expect(result.line_items).toEqual(["burrito bowl", "chips & queso"]);
    expect(result.extraction_status).toBe("extracted");
  });

  it("uses one request for extraction and categorization", async () => {
    createMock.mockResolvedValue(
      reply(receiptPayload({ suggested_category: "Food", category_confidence: 0.9 })),
    );

    await extractReceiptFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });

    // The follow-up header request only runs when header fields are missing.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("only offers the department's own categories to the model", async () => {
    createMock.mockResolvedValue(reply(receiptPayload({ suggested_category: "Food" })));

    await extractReceiptFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });

    const prompt = String(createMock.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain("- Food");
    expect(prompt).toContain("- Repairs & Maintenance");
    expect(prompt).toContain("Never invent a category name");
  });

  it("discards a category the department does not have", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          suggested_category: "Catering & Banquets",
          category_confidence: 0.99,
          category_reason: "invented",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result.suggested_category).toBeNull();
    expect(result.category_confidence).toBeNull();
    expect(result.merchant_name).toBe("Chipotle");
  });

  it("skips classification entirely when no category list is supplied", async () => {
    createMock.mockResolvedValue(reply(receiptPayload()));

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    const prompt = String(createMock.mock.calls[0][0].messages[0].content);
    expect(prompt).not.toContain("suggested_category");
    expect(result.suggested_category).toBeNull();
    expect(result.merchant_name).toBe("Chipotle");
  });
});

describe("categorization never blocks logging an expense", () => {
  it("still returns receipt fields when classification keys are missing", async () => {
    createMock.mockResolvedValue(reply(receiptPayload()));

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result.extraction_status).toBe("extracted");
    expect(result.total_amount).toBe("186.42");
    expect(result.suggested_category).toBeNull();
  });

  it("survives malformed classification output", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          suggested_category: { nope: true },
          category_confidence: "high",
          line_items: "not-an-array",
          two_percent_confidence: Number.NaN,
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result.suggested_category).toBeNull();
    expect(result.line_items).toBeNull();
    expect(result.two_percent_confidence).toBe(0);
    expect(result.merchant_name).toBe("Chipotle");
  });

  it("falls back cleanly when the model request fails", async () => {
    createMock.mockRejectedValue(new Error("upstream timeout"));

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result.extraction_status).toBe("failed");
    expect(result.suggested_category).toBeNull();
    expect(result.notes).toContain("upstream timeout");
  });

  it("keeps the no-API-key path unchanged", async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg", {
      allowedCategories: ALLOWED,
    });

    expect(result).toEqual(FALLBACK_EXTRACTION);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("keeps the PDF path unchanged", async () => {
    const result = await extractReceiptFromBuffer(IMAGE, "application/pdf", {
      allowedCategories: ALLOWED,
    });

    expect(result.extraction_status).toBe("needs_review");
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("tips in the extraction response", () => {
  it("keeps base, tip, and total separate when the receipt shows all three", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          base_amount: "90.95",
          tip_amount: "18.00",
          total_amount: "108.95",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.base_amount).toBe("90.95");
    expect(result.tip_amount).toBe("18.00");
    expect(result.total_amount).toBe("108.95");
    expect(result.extraction_status).toBe("extracted");
  });

  it("derives the tip from a handwritten total", async () => {
    createMock.mockResolvedValue(
      reply(receiptPayload({ base_amount: "90.95", total_amount: "108.95" })),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBe("18.00");
    expect(result.total_amount).toBe("108.95");
  });

  it("leaves the tip blank for an ordinary receipt", async () => {
    createMock.mockResolvedValue(reply(receiptPayload({ total_amount: "186.42" })));

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.base_amount).toBe("186.42");
    expect(result.total_amount).toBe("186.42");
  });

  it("does not double-count a printed service charge", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          base_amount: "200.00",
          tip_amount: "36.00",
          total_amount: "200.00",
          gratuity_included_in_total: true,
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.total_amount).toBe("200.00");
  });

  it("ignores an unreadable tip rather than guessing", async () => {
    createMock.mockResolvedValue(
      reply(receiptPayload({ base_amount: "42.10", tip_amount: "???", total_amount: "42.10" })),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.total_amount).toBe("42.10");
  });

  it("reads tips without making a second model call", async () => {
    createMock.mockResolvedValue(
      reply(receiptPayload({ base_amount: "90.95", tip_amount: "18.00", total_amount: "108.95" })),
    );

    await extractReceiptFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("returns blank tip fields when extraction fails", async () => {
    createMock.mockRejectedValue(new Error("upstream timeout"));

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.extraction_status).toBe("failed");
    expect(result.tip_amount).toBeNull();
    expect(result.base_amount).toBeNull();
  });
});

describe("telling tax apart from a tip", () => {
  it("does not report sales tax as a tip", async () => {
    // The Capo Restaurant bug: subtotal 85.00, tax 5.95, total 90.95.
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          subtotal_amount: "85.00",
          tax_amount: "5.95",
          base_amount: "90.95",
          total_amount: "90.95",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.tax_amount).toBe("5.95");
    expect(result.base_amount).toBe("90.95");
    expect(result.total_amount).toBe("90.95");
  });

  it("still reports no tip when the model puts the subtotal in base_amount", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          subtotal_amount: "85.00",
          tax_amount: "5.95",
          base_amount: "85.00",
          total_amount: "90.95",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.base_amount).toBe("90.95");
    expect(result.total_amount).toBe("90.95");
  });

  it("keeps tax and a handwritten tip separate", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          subtotal_amount: "85.00",
          tax_amount: "5.95",
          base_amount: "90.95",
          tip_amount: "18.00",
          total_amount: "108.95",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tax_amount).toBe("5.95");
    expect(result.tip_amount).toBe("18.00");
    expect(result.total_amount).toBe("108.95");
  });

  it("derives a tip from a handwritten total over the tax-inclusive pre-tip total", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          subtotal_amount: "85.00",
          tax_amount: "5.95",
          base_amount: "90.95",
          total_amount: "108.95",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBe("18.00");
    expect(result.total_amount).toBe("108.95");
  });

  it("preserves tax on an ordinary taxed purchase with no tip", async () => {
    createMock.mockResolvedValue(
      reply(
        receiptPayload({
          subtotal_amount: "172.61",
          tax_amount: "13.81",
          base_amount: "186.42",
          total_amount: "186.42",
        }),
      ),
    );

    const result = await extractReceiptFromBuffer(IMAGE, "image/jpeg");

    expect(result.tip_amount).toBeNull();
    expect(result.tax_amount).toBe("13.81");
    expect(result.total_amount).toBe("186.42");
  });
});
