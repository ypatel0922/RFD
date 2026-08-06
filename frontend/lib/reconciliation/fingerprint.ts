/**
 * Deterministic identity for an extracted statement line.
 *
 * The fingerprint lets a re-run of consolidation upsert the same rows instead of
 * duplicating them, and lets the UI address a line stably across retries. It is
 * built from the fields a bank would use to identify a posting, plus an
 * occurrence index.
 *
 * The occurrence index is what makes it safe: a fire department that pays two
 * $45.00 invoices to the same vendor on the same day has two legitimate rows,
 * and they get occurrence 0 and 1 rather than collapsing into one.
 */

import type { ConsolidatedLine, ExtractedPageLine } from "./types";

const DESCRIPTION_KEY_LENGTH = 48;

export type FingerprintInput = Pick<
  ExtractedPageLine,
  | "postedDate"
  | "transactionDate"
  | "normalizedDescription"
  | "signedAmountCents"
  | "checkNumber"
  | "referenceNumber"
>;

function fingerprintBase(accountKey: string, line: FingerprintInput): string {
  return [
    accountKey,
    line.postedDate ?? line.transactionDate ?? "nodate",
    line.signedAmountCents == null ? "noamount" : String(line.signedAmountCents),
    (line.normalizedDescription || "nodesc").slice(0, DESCRIPTION_KEY_LENGTH),
    line.checkNumber ?? "-",
    line.referenceNumber ?? "-",
  ].join("|");
}

/**
 * Assign fingerprints to lines in consolidated order. Must be called once, on
 * the full ordered statement, so occurrence indexes are stable.
 */
export function assignFingerprints(
  accountKey: string,
  lines: ExtractedPageLine[],
): ConsolidatedLine[] {
  const occurrences = new Map<string, number>();
  return lines.map((line, index) => {
    const base = fingerprintBase(accountKey, line);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      ...line,
      sequence: index,
      fingerprint: `${base}|#${occurrence}`,
    };
  });
}

/**
 * Content key ignoring occurrence order. Used to spot the same printed row
 * appearing on two overlapping photographs of the same page.
 */
export function lineContentKey(accountKey: string, line: FingerprintInput): string {
  return fingerprintBase(accountKey, line);
}
