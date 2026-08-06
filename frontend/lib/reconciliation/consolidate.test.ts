/**
 * Pass 2 consolidation scenarios: duplicate and overlapping photographs, missing
 * pages, wrapped descriptions, header rows, and period boundaries.
 */

import { describe, expect, it } from "vitest";

import { consolidateStatement } from "./consolidate";
import { ACCOUNT_KEY, dollars, page, pageHeader, pageLine } from "./test-fixtures";
import type { ConsolidationWarningCode } from "./types";

function warningCodes(codes: { code: ConsolidationWarningCode }[]): ConsolidationWarningCode[] {
  return codes.map((warning) => warning.code);
}

describe("scenario 10 — duplicate page upload", () => {
  it("uses one copy of an identical photo and says so", () => {
    const lines = [
      pageLine({ rowNumber: 1, postedDate: "2025-03-02", originalDescription: "WESTGATE HARDWARE", signedAmountCents: -dollars(75) }),
    ];

    const result = consolidateStatement(
      [
        page({ clientPageId: "a", pageOrder: 1, imageDigest: "same-photo", lines }),
        page({ clientPageId: "b", pageOrder: 2, imageDigest: "same-photo", lines }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines).toHaveLength(1);
    expect(result.duplicatePageGroups).toEqual([[1, 2]]);
    expect(warningCodes(result.warnings)).toContain("duplicate_page_image");
  });
});

describe("scenario 11 — overlapping photographs containing some of the same rows", () => {
  it("removes the repeated run without dropping the unique rows", () => {
    const shared = [
      pageLine({ rowNumber: 3, postedDate: "2025-03-08", originalDescription: "SUMMIT FUEL CO", signedAmountCents: -dollars(310.5) }),
      pageLine({ rowNumber: 4, postedDate: "2025-03-09", originalDescription: "VALLEY POWER", signedAmountCents: -dollars(120) }),
    ];

    const result = consolidateStatement(
      [
        page({
          clientPageId: "a",
          pageOrder: 1,
          imageDigest: "photo-a",
          header: pageHeader({ printedPageNumber: 1, printedPageCount: 2 }),
          lines: [
            pageLine({ rowNumber: 1, postedDate: "2025-03-04", originalDescription: "PINE STREET DINER", signedAmountCents: -dollars(62.4) }),
            pageLine({ rowNumber: 2, postedDate: "2025-03-06", originalDescription: "NORTH FORK PRINTING", signedAmountCents: -dollars(320) }),
            ...shared,
          ],
        }),
        page({
          clientPageId: "b",
          pageOrder: 2,
          imageDigest: "photo-b",
          header: pageHeader({ printedPageNumber: 2, printedPageCount: 2 }),
          lines: [
            ...shared.map((line, index) => pageLine({ ...line, rowNumber: index + 1 })),
            pageLine({ rowNumber: 3, postedDate: "2025-03-14", originalDescription: "LAKESIDE TIRE", signedAmountCents: -dollars(410) }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines.map((line) => line.originalDescription)).toEqual([
      "PINE STREET DINER",
      "NORTH FORK PRINTING",
      "SUMMIT FUEL CO",
      "VALLEY POWER",
      "LAKESIDE TIRE",
    ]);
    expect(warningCodes(result.warnings)).toContain("overlapping_pages");
  });

  it("keeps two genuine postings that happen to be identical on the same page", () => {
    const result = consolidateStatement(
      [
        page({
          lines: [
            pageLine({ rowNumber: 1, postedDate: "2025-03-05", originalDescription: "PARKING METER", signedAmountCents: -dollars(2), runningBalanceCents: dollars(998) }),
            pageLine({ rowNumber: 2, postedDate: "2025-03-05", originalDescription: "PARKING METER", signedAmountCents: -dollars(2), runningBalanceCents: dollars(996) }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines).toHaveLength(2);
  });
});

describe("scenario 12 — missing statement page", () => {
  it("names the page that was not added", () => {
    const result = consolidateStatement(
      [
        page({ clientPageId: "a", pageOrder: 1, imageDigest: "a", header: pageHeader({ printedPageNumber: 1, printedPageCount: 3 }), lines: [pageLine()] }),
        page({ clientPageId: "c", pageOrder: 2, imageDigest: "c", header: pageHeader({ printedPageNumber: 3, printedPageCount: 3 }), lines: [pageLine({ rowNumber: 1 })] }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.missingPrintedPages).toEqual([2]);
    expect(warningCodes(result.warnings)).toContain("missing_page_numbers");
  });
});

describe("scenario 16 — transaction description wrapping onto another line", () => {
  it("joins the wrapped text onto the row above", () => {
    const result = consolidateStatement(
      [
        page({
          lines: [
            pageLine({
              rowNumber: 1,
              postedDate: "2025-03-07",
              originalDescription: "ACH DEBIT CEDAR HOLLOW WATER",
              signedAmountCents: -dollars(88.4),
            }),
            pageLine({
              rowNumber: 2,
              postedDate: null,
              originalDescription: "DISTRICT AUTOPAY",
              signedAmountCents: null,
              runningBalanceCents: null,
            }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].originalDescription).toBe("ACH DEBIT CEDAR HOLLOW WATER DISTRICT AUTOPAY");
  });

  it("honours the model's own continuation flag", () => {
    const result = consolidateStatement(
      [
        page({
          lines: [
            pageLine({ rowNumber: 1, originalDescription: "WIRE TRANSFER OUT", signedAmountCents: -dollars(5_000) }),
            pageLine({
              rowNumber: 2,
              originalDescription: "TO RIDGELINE EQUIPMENT LLC",
              signedAmountCents: null,
              postedDate: null,
              isContinuation: true,
            }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines[0].originalDescription).toBe("WIRE TRANSFER OUT TO RIDGELINE EQUIPMENT LLC");
  });
});

describe("scenario 17 — page headers mistaken for transactions", () => {
  it("drops structural rows and keeps the real postings", () => {
    const result = consolidateStatement(
      [
        page({
          lines: [
            pageLine({ rowNumber: 1, originalDescription: "Date", signedAmountCents: null, postedDate: null }),
            pageLine({ rowNumber: 2, originalDescription: "Balance Forward", signedAmountCents: null, runningBalanceCents: dollars(1_000), postedDate: null }),
            pageLine({ rowNumber: 3, postedDate: "2025-03-05", originalDescription: "SUMMIT FUEL CO", signedAmountCents: -dollars(310.5) }),
            pageLine({ rowNumber: 4, originalDescription: "Total Withdrawals", signedAmountCents: -dollars(310.5), postedDate: null }),
            pageLine({ rowNumber: 5, originalDescription: "Page 1 of 1", signedAmountCents: null, postedDate: null }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines.map((line) => line.originalDescription)).toEqual(["SUMMIT FUEL CO"]);
    expect(result.removedRowCount).toBe(4);
  });
});

describe("scenario 24 — statement dates crossing a month or year boundary", () => {
  it("keeps a December-to-January period in order and flags nothing", () => {
    const result = consolidateStatement(
      [
        page({
          clientPageId: "a",
          pageOrder: 1,
          imageDigest: "a",
          header: pageHeader({
            statementStartDate: "2024-12-16",
            statementEndDate: "2025-01-15",
            printedPageNumber: 1,
            printedPageCount: 2,
            beginningBalanceCents: dollars(4_000),
          }),
          lines: [
            pageLine({ rowNumber: 1, postedDate: "2024-12-18", originalDescription: "HOLIDAY PARADE SUPPLIES", signedAmountCents: -dollars(240) }),
            pageLine({ rowNumber: 2, postedDate: "2024-12-31", originalDescription: "INTEREST PAID", signedAmountCents: dollars(1.12) }),
          ],
        }),
        page({
          clientPageId: "b",
          pageOrder: 2,
          imageDigest: "b",
          header: pageHeader({
            statementStartDate: "2024-12-16",
            statementEndDate: "2025-01-15",
            printedPageNumber: 2,
            printedPageCount: 2,
            endingBalanceCents: dollars(3_761.12),
          }),
          lines: [
            pageLine({ rowNumber: 1, postedDate: "2025-01-08", originalDescription: "VALLEY POWER AND LIGHT", signedAmountCents: -dollars(240) }),
          ],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.statementStartDate).toBe("2024-12-16");
    expect(result.statementEndDate).toBe("2025-01-15");
    expect(warningCodes(result.warnings)).not.toContain("chronology_out_of_order");
  });
});

describe("page ordering", () => {
  it("reorders pages photographed out of sequence using the printed page numbers", () => {
    const result = consolidateStatement(
      [
        page({
          clientPageId: "second-photo",
          pageOrder: 1,
          imageDigest: "b",
          header: pageHeader({ printedPageNumber: 2, printedPageCount: 2 }),
          lines: [pageLine({ rowNumber: 1, postedDate: "2025-03-20", originalDescription: "LATER ROW", signedAmountCents: -dollars(10) })],
        }),
        page({
          clientPageId: "first-photo",
          pageOrder: 2,
          imageDigest: "a",
          header: pageHeader({ printedPageNumber: 1, printedPageCount: 2 }),
          lines: [pageLine({ rowNumber: 1, postedDate: "2025-03-02", originalDescription: "EARLIER ROW", signedAmountCents: -dollars(10) })],
        }),
      ],
      { accountKey: ACCOUNT_KEY },
    );

    expect(result.lines.map((line) => line.originalDescription)).toEqual(["EARLIER ROW", "LATER ROW"]);
    expect(warningCodes(result.warnings)).toContain("page_order_uncertain");
  });
});

describe("fingerprints", () => {
  it("are stable across identical runs and distinct for repeated postings", () => {
    const build = () =>
      consolidateStatement(
        [
          page({
            lines: [
              pageLine({ rowNumber: 1, postedDate: "2025-03-05", originalDescription: "PARKING METER", signedAmountCents: -dollars(2), runningBalanceCents: dollars(998) }),
              pageLine({ rowNumber: 2, postedDate: "2025-03-05", originalDescription: "PARKING METER", signedAmountCents: -dollars(2), runningBalanceCents: dollars(996) }),
            ],
          }),
        ],
        { accountKey: ACCOUNT_KEY },
      );

    const first = build();
    const second = build();

    expect(first.lines.map((line) => line.fingerprint)).toEqual(second.lines.map((line) => line.fingerprint));
    expect(first.lines[0].fingerprint).not.toBe(first.lines[1].fingerprint);
  });
});
