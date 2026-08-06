/**
 * Pass 2 -- statement consolidation.
 *
 * Pass 1 reads each photograph independently and knows nothing about the pages
 * around it. This pass assembles those page results into a single statement:
 * it decides page order, joins descriptions that wrapped onto a second line,
 * drops repeated page headers and subtotal rows, removes rows duplicated by an
 * overlapping or re-uploaded photograph, and reconciles the header fields the
 * pages disagree about.
 *
 * It is deliberately conservative: anything ambiguous becomes a warning for the
 * treasurer instead of a silent correction.
 */

import { looksLikeNonTransactionRow, looksLikeWrappedContinuation } from "./description";
import { normalizeDescription } from "./description";
import { assignFingerprints, lineContentKey } from "./fingerprint";
import { absDaysBetween, toUtcMillis, type IsoDate } from "./dates";
import { findRunningBalanceGaps } from "./running-balance";
import type { Cents } from "./money";
import type {
  ConsolidatedLine,
  ConsolidatedStatement,
  ConsolidationWarning,
  ExtractedPageHeader,
  ExtractedPageLine,
} from "./types";

export type PageForConsolidation = {
  clientPageId: string;
  /** The order the treasurer arranged the pages in, 1-based. */
  pageOrder: number;
  /** sha256 of the preprocessed bytes, used only to spot the identical photo twice. */
  imageDigest: string | null;
  header: ExtractedPageHeader;
  lines: ExtractedPageLine[];
};

export type ConsolidateOptions = {
  /** Distinguishes fingerprints across accounts. Usually the bank account id. */
  accountKey: string;
};

export function consolidateStatement(
  pages: PageForConsolidation[],
  options: ConsolidateOptions,
): ConsolidatedStatement {
  const warnings: ConsolidationWarning[] = [];

  const { keptPages, duplicatePageGroups } = dropDuplicatePhotos(pages, warnings);
  const orderedPages = orderPages(keptPages, warnings);

  let removedRowCount = 0;
  const perPageLines: Array<{ page: PageForConsolidation; lines: ExtractedPageLine[] }> = [];

  for (const [index, page] of orderedPages.entries()) {
    const pageNumber = index + 1;
    const { lines, removed } = cleanPageRows(page.lines, pageNumber);
    removedRowCount += removed;
    perPageLines.push({ page, lines });
  }

  const { lines: stitched, removed: overlapRemoved } = removeOverlapBetweenPages(
    perPageLines,
    options.accountKey,
    warnings,
  );
  removedRowCount += overlapRemoved;

  const { lines: deduped, removed: dupRemoved } = removeRepeatedPostings(
    stitched,
    options.accountKey,
    warnings,
  );
  removedRowCount += dupRemoved;

  const consolidatedLines = assignFingerprints(options.accountKey, deduped);

  const header = mergeHeaders(orderedPages, warnings);
  const missingPrintedPages = findMissingPrintedPages(orderedPages, header.printedPageCount, warnings);

  checkChronology(consolidatedLines, warnings);
  checkRunningBalances(consolidatedLines, header.beginningBalanceCents, warnings);

  if (!consolidatedLines.length) {
    warnings.push({
      code: "no_transaction_lines",
      message:
        "No transaction rows were read from these pages. Check that the photos include the transaction list, not just the summary page.",
    });
  }

  return {
    ...header,
    observedPageCount: orderedPages.length,
    missingPrintedPages,
    duplicatePageGroups,
    lines: consolidatedLines,
    removedRowCount,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Duplicate photographs
// ---------------------------------------------------------------------------

function dropDuplicatePhotos(
  pages: PageForConsolidation[],
  warnings: ConsolidationWarning[],
): { keptPages: PageForConsolidation[]; duplicatePageGroups: number[][] } {
  const byDigest = new Map<string, PageForConsolidation[]>();
  const keptPages: PageForConsolidation[] = [];
  const duplicatePageGroups: number[][] = [];

  for (const page of [...pages].sort((a, b) => a.pageOrder - b.pageOrder)) {
    if (!page.imageDigest) {
      keptPages.push(page);
      continue;
    }
    const existing = byDigest.get(page.imageDigest);
    if (existing) {
      existing.push(page);
      continue;
    }
    byDigest.set(page.imageDigest, [page]);
    keptPages.push(page);
  }

  for (const group of byDigest.values()) {
    if (group.length < 2) continue;
    const pageNumbers = group.map((page) => page.pageOrder);
    duplicatePageGroups.push(pageNumbers);
    warnings.push({
      code: "duplicate_page_image",
      message: `Pages ${pageNumbers.join(", ")} are the same photo. Only the first copy was used.`,
      pageNumbers,
    });
  }

  return { keptPages, duplicatePageGroups };
}

// ---------------------------------------------------------------------------
// Page ordering
// ---------------------------------------------------------------------------

/**
 * Prefer the statement's own printed "Page X of Y" numbering when every page
 * carries a distinct one -- a treasurer photographing pages out of order is
 * common, and the printed numbers are authoritative. Otherwise keep the order
 * shown in the wizard.
 */
function orderPages(
  pages: PageForConsolidation[],
  warnings: ConsolidationWarning[],
): PageForConsolidation[] {
  const byUserOrder = [...pages].sort((a, b) => a.pageOrder - b.pageOrder);
  const printed = byUserOrder.map((page) => page.header.printedPageNumber);
  const allPrinted = printed.every((value): value is number => typeof value === "number" && value > 0);
  const distinct = new Set(printed).size === printed.length;

  if (!allPrinted || !distinct) {
    if (byUserOrder.length > 1 && printed.some((value) => value == null)) {
      warnings.push({
        code: "missing_page_numbers",
        message:
          "Some pages do not show a page number, so the pages were kept in the order you arranged them.",
      });
    }
    return byUserOrder;
  }

  const byPrinted = [...byUserOrder].sort(
    (a, b) => (a.header.printedPageNumber ?? 0) - (b.header.printedPageNumber ?? 0),
  );
  const reordered = byPrinted.some((page, index) => page.clientPageId !== byUserOrder[index]?.clientPageId);
  if (reordered) {
    warnings.push({
      code: "page_order_uncertain",
      message:
        "Pages were reordered to match the page numbers printed on the statement.",
      pageNumbers: byPrinted.map((page) => page.header.printedPageNumber ?? 0),
    });
  }
  return byPrinted;
}

// ---------------------------------------------------------------------------
// Row cleaning within a page
// ---------------------------------------------------------------------------

/**
 * Drop structural rows and fold wrapped description lines into the row above.
 * Row numbers are re-sequenced so the stored `row_number` matches the order the
 * treasurer sees, while `pageNumber` keeps traceability back to the photograph.
 */
function cleanPageRows(
  lines: ExtractedPageLine[],
  pageNumber: number,
): { lines: ExtractedPageLine[]; removed: number } {
  const ordered = [...lines].sort((a, b) => a.rowNumber - b.rowNumber);
  const kept: ExtractedPageLine[] = [];
  let removed = 0;

  for (const line of ordered) {
    const isStructural = looksLikeNonTransactionRow(line.originalDescription);
    // Trust the model's explicit continuation flag, and fall back to the shape
    // of the row (no date, no amount, short trailing text) when it is absent.
    const isContinuation = line.isContinuation || looksLikeWrappedContinuation(line);

    if (isContinuation && kept.length && !isStructural) {
      const previous = kept[kept.length - 1];
      const joined = `${previous.originalDescription} ${line.originalDescription}`.replace(/\s+/g, " ").trim();
      kept[kept.length - 1] = {
        ...previous,
        originalDescription: joined,
        normalizedDescription: normalizeDescription(joined),
        // Keep the more cautious of the two confidences.
        extractionConfidence: Math.min(previous.extractionConfidence, line.extractionConfidence),
        extractionWarning: previous.extractionWarning ?? line.extractionWarning,
      };
      removed += 1;
      continue;
    }

    if (isStructural) {
      removed += 1;
      continue;
    }

    if (line.signedAmountCents == null && line.runningBalanceCents == null) {
      // Keep the row for review rather than silently deleting it. Pass 1 now
      // attaches a warning when the amount is missing; if somehow it did not,
      // add one here so the treasurer can see and correct it.
      kept.push({
        ...line,
        pageNumber,
        rowNumber: kept.length + 1,
        extractionWarning:
          line.extractionWarning ??
          "No amount was read for this row. Check the statement and correct it if needed.",
      });
      continue;
    }

    kept.push({ ...line, pageNumber, rowNumber: kept.length + 1 });
  }

  return { lines: kept, removed };
}

// ---------------------------------------------------------------------------
// Overlapping photographs
// ---------------------------------------------------------------------------

/**
 * Two photos of the same page, or a photo that caught the top of the next page,
 * produce the same printed rows twice. Detect it as a contiguous run: the last
 * N rows of one page matching the first N rows of the next. A run is required
 * rather than individual matches so that two genuinely identical postings on
 * consecutive pages are not silently merged.
 */
function removeOverlapBetweenPages(
  perPage: Array<{ page: PageForConsolidation; lines: ExtractedPageLine[] }>,
  accountKey: string,
  warnings: ConsolidationWarning[],
): { lines: ExtractedPageLine[]; removed: number } {
  const result: ExtractedPageLine[] = [];
  let removed = 0;

  for (const [index, entry] of perPage.entries()) {
    if (index === 0 || !entry.lines.length || !result.length) {
      result.push(...entry.lines);
      continue;
    }

    const previousKeys = result.map((line) => lineContentKey(accountKey, line));
    const currentKeys = entry.lines.map((line) => lineContentKey(accountKey, line));
    const maxRun = Math.min(previousKeys.length, currentKeys.length);

    let overlap = 0;
    for (let run = maxRun; run >= 1; run -= 1) {
      const tail = previousKeys.slice(previousKeys.length - run);
      const head = currentKeys.slice(0, run);
      if (tail.every((key, position) => key === head[position])) {
        overlap = run;
        break;
      }
    }

    if (overlap > 0) {
      removed += overlap;
      warnings.push({
        code: "overlapping_pages",
        message: `Page ${entry.page.pageOrder} repeats ${overlap} row${overlap === 1 ? "" : "s"} already read from the previous page. The repeated row${overlap === 1 ? " was" : "s were"} removed.`,
        pageNumbers: [entry.page.pageOrder],
      });
    }

    result.push(...entry.lines.slice(overlap));
  }

  return { lines: result, removed };
}

/**
 * A second safety net for non-adjacent repeats: identical content key *and*
 * identical printed running balance. Two separate postings can share a vendor,
 * amount and date, but they cannot leave the account at the same balance, so
 * this only fires on a genuine duplicate read.
 */
function removeRepeatedPostings(
  lines: ExtractedPageLine[],
  accountKey: string,
  warnings: ConsolidationWarning[],
): { lines: ExtractedPageLine[]; removed: number } {
  const seen = new Set<string>();
  const kept: ExtractedPageLine[] = [];
  const removedPages = new Set<number>();
  let removed = 0;

  for (const line of lines) {
    if (line.runningBalanceCents == null) {
      kept.push(line);
      continue;
    }
    const key = `${lineContentKey(accountKey, line)}|bal:${line.runningBalanceCents}`;
    if (seen.has(key)) {
      removed += 1;
      removedPages.add(line.pageNumber);
      continue;
    }
    seen.add(key);
    kept.push(line);
  }

  if (removed > 0) {
    warnings.push({
      code: "duplicate_rows_removed",
      message: `${removed} repeated transaction row${removed === 1 ? "" : "s"} with the same amount, date and running balance ${removed === 1 ? "was" : "were"} removed.`,
      pageNumbers: [...removedPages].sort((a, b) => a - b),
    });
  }

  return { lines: kept, removed };
}

// ---------------------------------------------------------------------------
// Header merge
// ---------------------------------------------------------------------------

type MergedHeader = Pick<
  ConsolidatedStatement,
  | "financialInstitution"
  | "accountType"
  | "accountHolder"
  | "accountLastFour"
  | "statementStartDate"
  | "statementEndDate"
  | "beginningBalanceCents"
  | "endingBalanceCents"
  | "reportedTotalCreditsCents"
  | "reportedTotalDebitsCents"
  | "printedPageCount"
>;

function mergeHeaders(
  pages: PageForConsolidation[],
  warnings: ConsolidationWarning[],
): MergedHeader {
  const headers = pages.map((page) => page.header);

  const startDates = distinctValues(headers.map((header) => header.statementStartDate));
  const endDates = distinctValues(headers.map((header) => header.statementEndDate));
  if (startDates.length > 1 || endDates.length > 1) {
    warnings.push({
      code: "conflicting_statement_period",
      message:
        "The pages show different statement periods. Check that every photo is from the same statement.",
    });
  }

  // The beginning balance is printed on the first page and the ending balance on
  // the last, so read each from the end of the statement it belongs to.
  const beginning = firstNonNull(headers.map((header) => header.beginningBalanceCents));
  const ending = lastNonNull(headers.map((header) => header.endingBalanceCents));

  const beginningValues = distinctValues(headers.map((header) => header.beginningBalanceCents));
  const endingValues = distinctValues(headers.map((header) => header.endingBalanceCents));
  if (beginningValues.length > 1 || endingValues.length > 1) {
    warnings.push({
      code: "conflicting_balances",
      message:
        "The pages report different beginning or ending balances. The values from the first and last page were used.",
    });
  }

  return {
    financialInstitution: firstNonNull(headers.map((header) => header.financialInstitution)),
    accountType: firstNonNull(headers.map((header) => header.accountType)),
    accountHolder: firstNonNull(headers.map((header) => header.accountHolder)),
    accountLastFour: firstNonNull(headers.map((header) => header.accountLastFour)),
    statementStartDate: earliestDate(headers.map((header) => header.statementStartDate)),
    statementEndDate: latestDate(headers.map((header) => header.statementEndDate)),
    beginningBalanceCents: beginning,
    endingBalanceCents: ending,
    reportedTotalCreditsCents: firstNonNull(headers.map((header) => header.totalCreditsCents)),
    reportedTotalDebitsCents: firstNonNull(headers.map((header) => header.totalDebitsCents)),
    printedPageCount: mostCommon(headers.map((header) => header.printedPageCount)),
  };
}

function findMissingPrintedPages(
  pages: PageForConsolidation[],
  printedPageCount: number | null,
  warnings: ConsolidationWarning[],
): number[] {
  if (!printedPageCount || printedPageCount < 1) return [];
  const present = new Set(
    pages
      .map((page) => page.header.printedPageNumber)
      .filter((value): value is number => typeof value === "number"),
  );
  const missing: number[] = [];
  for (let page = 1; page <= printedPageCount; page += 1) {
    if (!present.has(page)) missing.push(page);
  }
  if (missing.length) {
    warnings.push({
      code: "missing_page_numbers",
      message: `The statement says it has ${printedPageCount} pages. Page ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
      pageNumbers: missing,
    });
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Continuity checks
// ---------------------------------------------------------------------------

/**
 * Statements list transactions in date order. A backwards jump of more than a
 * couple of days usually means a page was photographed out of order or a date
 * was misread.
 */
function checkChronology(lines: ConsolidatedLine[], warnings: ConsolidationWarning[]): void {
  let previous: { date: IsoDate; pageNumber: number } | null = null;
  const offendingPages = new Set<number>();

  for (const line of lines) {
    const date = line.postedDate ?? line.transactionDate;
    if (!date) continue;
    if (previous) {
      const previousMillis = toUtcMillis(previous.date);
      const currentMillis = toUtcMillis(date);
      if (previousMillis != null && currentMillis != null && currentMillis < previousMillis) {
        const gapDays = absDaysBetween(previous.date, date) ?? 0;
        if (gapDays > 2) offendingPages.add(line.pageNumber);
      }
    }
    previous = { date, pageNumber: line.pageNumber };
  }

  if (offendingPages.size) {
    const pageNumbers = [...offendingPages].sort((a, b) => a - b);
    warnings.push({
      code: "chronology_out_of_order",
      message: `Transaction dates go backwards on page ${pageNumbers.join(", ")}. Check the page order and the dates on that page.`,
      pageNumbers,
    });
  }
}

function checkRunningBalances(
  lines: ConsolidatedLine[],
  beginningBalanceCents: Cents | null,
  warnings: ConsolidationWarning[],
): void {
  const gaps = findRunningBalanceGaps(lines, beginningBalanceCents);
  if (!gaps.length) return;
  const pageNumbers = [...new Set(gaps.map((gap) => gap.pageNumber))].sort((a, b) => a - b);
  warnings.push({
    code: "running_balance_gap",
    message: `The running balance does not add up at ${gaps.length} row${gaps.length === 1 ? "" : "s"} on page ${pageNumbers.join(", ")}.`,
    pageNumbers,
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  for (const value of values) if (value != null) return value;
  return null;
}

function lastNonNull<T>(values: Array<T | null | undefined>): T | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value != null) return value;
  }
  return null;
}

function distinctValues<T>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value != null))];
}

function earliestDate(values: Array<IsoDate | null | undefined>): IsoDate | null {
  const dates = distinctValues(values).filter((value) => toUtcMillis(value) != null);
  if (!dates.length) return null;
  return dates.reduce((earliest, value) => ((toUtcMillis(value) ?? 0) < (toUtcMillis(earliest) ?? 0) ? value : earliest));
}

function latestDate(values: Array<IsoDate | null | undefined>): IsoDate | null {
  const dates = distinctValues(values).filter((value) => toUtcMillis(value) != null);
  if (!dates.length) return null;
  return dates.reduce((latest, value) => ((toUtcMillis(value) ?? 0) > (toUtcMillis(latest) ?? 0) ? value : latest));
}

function mostCommon<T>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value == null) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
