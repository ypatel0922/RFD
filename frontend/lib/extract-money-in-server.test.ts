/**
 * Check / payment document extraction.
 *
 * Two properties matter: the payment details come back ready to review, and
 * nothing that looks like the payer's routing or account number ever leaves
 * this module — even if the model returns it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

const { extractMoneyInFromBuffer, FALLBACK_MONEY_IN_EXTRACTION, MONEY_IN_SYSTEM_PROMPT } = await import(
  "./extract-money-in-server"
);

const ALLOWED = ["NYS 2% Deposit", "Donations Received", "Other Income"];
const IMAGE = Buffer.from("fake-check-bytes");

function reply(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  createMock.mockReset();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("reading a donation check", () => {
  it("extracts the source, amount, date and check number for review", async () => {
    createMock.mockResolvedValue(
      reply({
        document_type: "check",
        payer: "Smith Family",
        amount: "250.00",
        date: "2026-03-09",
        check_number: "1042",
        memo: "In memory of John Smith",
        suggested_category: "Donations Received",
        category_confidence: 0.9,
        suggest_two_percent: false,
        confidence: 0.93,
      }),
    );

    const result = await extractMoneyInFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });

    expect(result.payer).toBe("Smith Family");
    expect(result.amount).toBe("250.00");
    expect(result.date).toBe("2026-03-09");
    expect(result.check_number).toBe("1042");
    expect(result.payment_method).toBe("check");
    expect(result.suggested_category).toBe("Donations Received");
    expect(result.extraction_status).toBe("extracted");
  });

  it("drops routing and account numbers even when the model returns them", async () => {
    createMock.mockResolvedValue(
      reply({
        document_type: "check",
        payer: "Village of Springfield",
        amount: 8000,
        date: "2026-03-01",
        check_number: "⑆021000021⑆ 123456789012⑈ 5531",
        memo: "Foreign fire tax. Routing 021000021 Acct 123456789012",
        notes: "MICR line reads 021000021 123456789012",
      }),
    );

    const result = await extractMoneyInFromBuffer(IMAGE, "image/png", { allowedCategories: ALLOWED });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/021000021|123456789012|⑆|⑈/);
    expect(result.check_number).toBeNull();
    expect(result.memo).toContain("Foreign fire tax");
  });

  it("asks the model not to return banking details", () => {
    expect(MONEY_IN_SYSTEM_PROMPT).toMatch(/routing/i);
    expect(MONEY_IN_SYSTEM_PROMPT).toMatch(/account number/i);
  });

  it("only returns a category the department can use", async () => {
    createMock.mockResolvedValue(reply({ payer: "Lions Club", amount: "50", date: "2026-03-02", suggested_category: "Office Supplies" }));
    const result = await extractMoneyInFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });
    expect(result.suggested_category).toBeNull();
  });
});

describe("failures never block recording", () => {
  it("returns an empty draft without an API key", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await extractMoneyInFromBuffer(IMAGE, "image/jpeg")).toEqual(FALLBACK_MONEY_IN_EXTRACTION);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("marks a thrown request as failed so the user enters it manually", async () => {
    createMock.mockRejectedValue(new Error("upstream timeout"));
    const result = await extractMoneyInFromBuffer(IMAGE, "image/jpeg", { allowedCategories: ALLOWED });
    expect(result.extraction_status).toBe("failed");
    expect(result.payer).toBeNull();
  });

  it("does not send PDFs to the model", async () => {
    const result = await extractMoneyInFromBuffer(IMAGE, "application/pdf");
    expect(createMock).not.toHaveBeenCalled();
    expect(result.extraction_status).not.toBe("extracted");
  });
});
