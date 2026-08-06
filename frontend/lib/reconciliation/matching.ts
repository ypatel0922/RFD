/**
 * Deterministic statement-to-ledger matching.
 *
 * Every decision here is reproducible from the inputs: no model call, no
 * randomness, no dependence on row order beyond explicit tie-breaks. The score
 * is a sum of weighted signals (see `config.ts`) and every point awarded is
 * recorded as a plain-language reason so a treasurer -- or an auditor a year
 * later -- can see exactly why two rows were paired.
 *
 * Matching is strictly one-to-one. A Hallix transaction can back at most one
 * statement line and vice versa. Split and aggregate matches (three Hallix
 * entries adding up to one bank withdrawal) are intentionally *not* attempted;
 * those lines fall through to manual review.
 */

import {
  AMBIGUOUS_MARGIN,
  AMOUNT_NEAR_TOLERANCE_CENTS,
  AMOUNT_NEAR_TOLERANCE_RATIO,
  AUTO_MATCH_MIN_SCORE,
  AUTO_MATCH_UNIQUENESS_MARGIN,
  MAX_SCORE,
  POSSIBLE_MATCH_MIN_SCORE,
  SCORE_WEIGHTS,
  TIP_MAX_OVERAGE_CENTS,
  tipToleranceRatio,
  VENDOR_PARTIAL_SIMILARITY,
  VENDOR_WEAK_SIMILARITY,
  vendorStrongSimilarity,
} from "./config";
import { daysBetween, isWithinPeriod, type IsoDate } from "./dates";
import { containsVendorName, descriptionSimilarity } from "./description";
import { formatCents } from "./money";
import type {
  ConsolidatedLine,
  LedgerCandidate,
  LineMatchResult,
  MatchReason,
  MatchRunResult,
  MatchStatus,
  ScoredCandidate,
} from "./types";

/** A decision the treasurer already made, preserved across re-runs. */
export type LockedLineDecision = {
  matchStatus: MatchStatus;
  matchedExpenseId: string | null;
  matchScore: number | null;
  matchReasons: MatchReason[];
};

export type MatchInput = {
  lines: ConsolidatedLine[];
  candidates: LedgerCandidate[];
  statementStartDate: IsoDate | null;
  statementEndDate: IsoDate | null;
  /** Name of the Hallix account being reconciled, for the account-match signal. */
  selectedAccountName: string | null;
  dateToleranceDays: number;
  /** Keyed by line fingerprint. */
  lockedLines?: Record<string, LockedLineDecision>;
};

export function matchStatementToLedger(input: MatchInput): MatchRunResult {
  const locked = input.lockedLines ?? {};

  // Expenses pinned by a manual decision are unavailable to the automatic pass.
  const lockedExpenseIds = new Set(
    Object.values(locked)
      .map((decision) => decision.matchedExpenseId)
      .filter((value): value is string => Boolean(value)),
  );

  const candidateById = new Map(input.candidates.map((candidate) => [candidate.expenseId, candidate]));

  type LineWorking = {
    line: ConsolidatedLine;
    scored: ScoredCandidate[];
    available: ScoredCandidate[];
    assigned: ScoredCandidate | null;
  };

  const working: LineWorking[] = input.lines.map((line) => {
    if (locked[line.fingerprint]) {
      return { line, scored: [], available: [], assigned: null };
    }
    const scored = scoreLineCandidates(line, input.candidates, input);
    const available = scored.filter(
      (candidate) =>
        !lockedExpenseIds.has(candidate.expenseId) &&
        !candidateById.get(candidate.expenseId)?.isAlreadyReconciled,
    );
    return { line, scored, available, assigned: null };
  });

  // --- Greedy one-to-one assignment ---------------------------------------
  // Pairs are sorted by a total order so the result is identical on every run.
  type Pair = { lineIndex: number; candidate: ScoredCandidate };
  const pairs: Pair[] = [];
  for (const [lineIndex, entry] of working.entries()) {
    for (const candidate of entry.available) {
      if (candidate.score >= POSSIBLE_MATCH_MIN_SCORE) pairs.push({ lineIndex, candidate });
    }
  }

  pairs.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) return right.candidate.score - left.candidate.score;
    if (left.candidate.exactAmount !== right.candidate.exactAmount) {
      return left.candidate.exactAmount ? -1 : 1;
    }
    const leftDelta = left.candidate.dayDelta == null ? 9999 : Math.abs(left.candidate.dayDelta);
    const rightDelta = right.candidate.dayDelta == null ? 9999 : Math.abs(right.candidate.dayDelta);
    if (leftDelta !== rightDelta) return leftDelta - rightDelta;
    if (left.lineIndex !== right.lineIndex) return left.lineIndex - right.lineIndex;
    return left.candidate.expenseId.localeCompare(right.candidate.expenseId);
  });

  const usedExpenseIds = new Set<string>(lockedExpenseIds);
  for (const pair of pairs) {
    const entry = working[pair.lineIndex];
    if (entry.assigned) continue;
    if (usedExpenseIds.has(pair.candidate.expenseId)) continue;
    entry.assigned = pair.candidate;
    usedExpenseIds.add(pair.candidate.expenseId);
  }

  // --- Classification -----------------------------------------------------
  const results: LineMatchResult[] = [];
  const releasedExpenseIds = new Set<string>();

  for (const entry of working) {
    const lockedDecision = locked[entry.line.fingerprint];
    if (lockedDecision) {
      results.push({
        fingerprint: entry.line.fingerprint,
        matchStatus: lockedDecision.matchStatus,
        matchedExpenseId: lockedDecision.matchedExpenseId,
        matchScore: lockedDecision.matchScore,
        matchReasons: lockedDecision.matchReasons,
        candidateExpenseIds: lockedDecision.matchedExpenseId ? [lockedDecision.matchedExpenseId] : [],
      });
      continue;
    }

    const candidateExpenseIds = entry.available
      .filter((candidate) => candidate.score >= POSSIBLE_MATCH_MIN_SCORE)
      .slice(0, 5)
      .map((candidate) => candidate.expenseId);

    if (entry.assigned) {
      const assigned = entry.assigned;
      // The runner-up only counts as competition if no other line claimed it.
      const runnerUp = entry.available.find(
        (candidate) =>
          candidate.expenseId !== assigned.expenseId && !usedExpenseIds.has(candidate.expenseId),
      );
      const margin = runnerUp ? assigned.score - runnerUp.score : 1;

      const isAmbiguous = Boolean(runnerUp) && margin < AMBIGUOUS_MARGIN && assigned.score >= 0.6;

      if (isAmbiguous) {
        // Do not consume the transaction: the treasurer picks which one it is.
        usedExpenseIds.delete(assigned.expenseId);
        releasedExpenseIds.add(assigned.expenseId);
        results.push({
          fingerprint: entry.line.fingerprint,
          matchStatus: "ambiguous_duplicate",
          matchedExpenseId: null,
          matchScore: round4(assigned.score),
          matchReasons: [
            ...assigned.reasons,
            {
              code: "competing_candidate",
              label: `Another recorded transaction fits this line just as well (${formatPercent(runnerUp!.score)} vs ${formatPercent(assigned.score)}). Pick the right one.`,
              points: 0,
            },
          ],
          candidateExpenseIds,
        });
        continue;
      }

      const qualifiesAutomatically =
        !assigned.directionMismatch &&
        assigned.exactAmount &&
        assigned.dayDelta != null &&
        Math.abs(assigned.dayDelta) <= input.dateToleranceDays &&
        (assigned.vendorSimilarity >= vendorStrongSimilarity() ||
          assigned.vendorContained ||
          assigned.hasStrongIdentifier) &&
        assigned.score >= AUTO_MATCH_MIN_SCORE &&
        margin >= AUTO_MATCH_UNIQUENESS_MARGIN;

      results.push({
        fingerprint: entry.line.fingerprint,
        matchStatus: qualifiesAutomatically ? "auto_matched" : "possible_match",
        matchedExpenseId: assigned.expenseId,
        matchScore: round4(assigned.score),
        matchReasons: qualifiesAutomatically
          ? [
              ...assigned.reasons,
              {
                code: "unique_candidate",
                label: "No other recorded transaction is a close fit.",
                points: 0,
              },
            ]
          : [...assigned.reasons, ...reviewReasons(assigned, input.dateToleranceDays)],
        candidateExpenseIds,
      });
      continue;
    }

    // No assignment. Work out the most useful explanation.
    const bestOverall = entry.scored[0];
    const bestReconciled = entry.scored.find(
      (candidate) => candidateById.get(candidate.expenseId)?.isAlreadyReconciled,
    );

    if (bestReconciled && bestReconciled.score >= AUTO_MATCH_MIN_SCORE) {
      results.push({
        fingerprint: entry.line.fingerprint,
        matchStatus: "already_reconciled",
        matchedExpenseId: null,
        matchScore: round4(bestReconciled.score),
        matchReasons: [
          ...bestReconciled.reasons,
          {
            code: "already_reconciled",
            label: "The matching Hallix transaction was already reconciled in an earlier statement.",
            points: 0,
          },
        ],
        candidateExpenseIds: [bestReconciled.expenseId],
      });
      continue;
    }

    const lineDate = entry.line.postedDate ?? entry.line.transactionDate;
    const outsidePeriod =
      Boolean(lineDate) &&
      Boolean(input.statementStartDate || input.statementEndDate) &&
      !isWithinPeriod(lineDate, input.statementStartDate, input.statementEndDate);

    results.push({
      fingerprint: entry.line.fingerprint,
      matchStatus: outsidePeriod ? "outside_period" : "unmatched",
      matchedExpenseId: null,
      matchScore: bestOverall ? round4(bestOverall.score) : null,
      matchReasons: candidateExpenseIds.length
        ? [
            {
              code: "competing_candidate",
              label: "A possible match was found but another statement line is a better fit for it.",
              points: 0,
            },
          ]
        : [],
      candidateExpenseIds,
    });
  }

  // --- Hallix transactions the statement never mentioned -------------------
  const claimed = new Set(
    results
      .map((result) => result.matchedExpenseId)
      .filter((value): value is string => Boolean(value)),
  );

  const ledgerOnlyExpenseIds = input.candidates
    .filter((candidate) => {
      if (claimed.has(candidate.expenseId)) return false;
      if (candidate.isAlreadyReconciled) return false;
      if (!belongsToSelectedAccount(candidate, input.selectedAccountName)) return false;
      return isWithinPeriod(candidate.date, input.statementStartDate, input.statementEndDate);
    })
    .map((candidate) => candidate.expenseId);

  const counts = {
    matched: results.filter(
      (result) => result.matchStatus === "auto_matched" || result.matchStatus === "manually_matched",
    ).length,
    needsReview: results.filter(
      (result) => result.matchStatus === "possible_match" || result.matchStatus === "ambiguous_duplicate",
    ).length,
    statementOnly: results.filter(
      (result) => result.matchStatus === "unmatched" || result.matchStatus === "outside_period",
    ).length,
    ledgerOnly: ledgerOnlyExpenseIds.length,
  };

  return { lines: results, ledgerOnlyExpenseIds, counts };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreLineCandidates(
  line: ConsolidatedLine,
  candidates: LedgerCandidate[],
  options: { dateToleranceDays: number; selectedAccountName: string | null },
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(line, candidate, options);
    if (result) scored.push(result);
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftDelta = left.dayDelta == null ? 9999 : Math.abs(left.dayDelta);
    const rightDelta = right.dayDelta == null ? 9999 : Math.abs(right.dayDelta);
    if (leftDelta !== rightDelta) return leftDelta - rightDelta;
    return left.expenseId.localeCompare(right.expenseId);
  });
  return scored;
}

/**
 * Score one statement line against one Hallix transaction. Returns null when the
 * pair is disqualified outright -- unreadable amount, a date so far away it
 * cannot be the same posting, or opposite direction without a strong name and
 * date agreement.
 */
function scoreCandidate(
  line: ConsolidatedLine,
  candidate: LedgerCandidate,
  options: { dateToleranceDays: number; selectedAccountName: string | null },
): ScoredCandidate | null {
  if (line.signedAmountCents == null || candidate.signedAmountCents == null) return null;
  if (line.signedAmountCents === 0 || candidate.signedAmountCents === 0) return null;

  const lineIsCredit = line.signedAmountCents > 0;
  const candidateIsCredit = candidate.signedAmountCents > 0;
  const directionMismatch = lineIsCredit !== candidateIsCredit;

  const reasons: MatchReason[] = [];
  let points = 0;

  // The vendor and date signals are worked out first because the amount
  // tolerance depends on them: a charge is only forgiven for a tip when the name
  // and the date already agree. Opposite-sign pairs also need that confirmation
  // before they are even considered.
  const { vendorSimilarity, vendorContained } = bestVendorSignal(
    line.normalizedDescription,
    candidate,
  );
  // Forgiving the amount is only safe on a name we are sure about. A partial
  // resemblance ("National Fuel" against "National Grid") is not enough.
  const vendorConfirmed = vendorContained || vendorSimilarity >= vendorStrongSimilarity();

  const lineDate = line.postedDate ?? line.transactionDate;
  const dayDelta = daysBetween(lineDate, candidate.date);
  const withinDateTolerance = dayDelta != null && Math.abs(dayDelta) <= options.dateToleranceDays;

  // A deposit is rarely the same event as a withdrawal. Only surface the pair
  // for review when the name and date already agree — OCR or column confusion
  // sometimes flips the printed sign while the merchant and dollars are right.
  if (directionMismatch && (!vendorConfirmed || !withinDateTolerance)) return null;

  const lineAbs = Math.abs(line.signedAmountCents);
  const candidateAbs = Math.abs(candidate.signedAmountCents);
  const amountDifferenceCents = line.signedAmountCents - candidate.signedAmountCents;
  const exactAmount = directionMismatch ? lineAbs === candidateAbs : amountDifferenceCents === 0;
  // Tip forgiveness only when both sides are real outflows. A flipped sign is
  // already suspicious enough; demand a close magnitude match without inventing a tip.
  const gratuityCents = directionMismatch
    ? null
    : gratuityOverage({
        lineCents: line.signedAmountCents,
        candidateCents: candidate.signedAmountCents,
        vendorConfirmed,
        withinDateTolerance,
      });
  const likelyGratuity = gratuityCents != null;

  if (directionMismatch) {
    reasons.push({
      code: "amount_sign_mismatch",
      label:
        "The statement shows the opposite direction (credit vs debit) from the Hallix entry. Confirm the signs before matching.",
      points: 0,
    });
  }

  if (exactAmount) {
    points += SCORE_WEIGHTS.exactAmount;
    reasons.push({
      code: "exact_amount",
      label: `Amount matches exactly (${formatCents(lineAbs)}).`,
      points: SCORE_WEIGHTS.exactAmount,
    });
  } else {
    const difference = Math.abs(lineAbs - candidateAbs);
    const allowance = Math.max(
      AMOUNT_NEAR_TOLERANCE_CENTS,
      Math.round(lineAbs * AMOUNT_NEAR_TOLERANCE_RATIO),
    );
    if (difference > allowance && gratuityCents == null) return null;

    const nearPoints = Math.round(SCORE_WEIGHTS.exactAmount * 0.45);
    points += nearPoints;
    reasons.push(
      gratuityCents != null
        ? {
            code: "amount_tip",
            label: `The bank charged ${formatCents(gratuityCents)} more than the ${formatCents(candidateAbs)} recorded (${percentOf(gratuityCents, candidateAbs)} more), which is the size of a tip added after the receipt was printed.`,
            points: nearPoints,
          }
        : {
            code: "amount_direction",
            label: `Amount is close but not exact: statement ${formatCents(lineAbs)} vs recorded ${formatCents(candidateAbs)}.`,
            points: nearPoints,
          },
    );
  }

  if (dayDelta == null) {
    reasons.push({
      code: "date_outside_tolerance",
      label: "One of the two dates is missing, so the dates could not be compared.",
      points: 0,
    });
  } else {
    const distance = Math.abs(dayDelta);
    if (distance > options.dateToleranceDays * 2) return null;

    if (distance === 0) {
      points += SCORE_WEIGHTS.sameDay;
      reasons.push({
        code: "same_day",
        label: "Posted on the same day it was recorded in Hallix.",
        points: SCORE_WEIGHTS.sameDay,
      });
    } else {
      const awarded =
        distance <= 2
          ? SCORE_WEIGHTS.dateWithinTwoDays
          : distance <= 4
            ? SCORE_WEIGHTS.dateWithinFourDays
            : distance <= options.dateToleranceDays
              ? SCORE_WEIGHTS.dateWithinTolerance
              : 0;
      points += awarded;
      const dayWord = distance === 1 ? "day" : "days";
      reasons.push({
        code: awarded > 0 ? (dayDelta > 0 ? "posted_after" : "posted_before") : "date_outside_tolerance",
        label:
          awarded > 0
            ? dayDelta > 0
              ? `Posted ${distance} ${dayWord} after the Hallix date.`
              : `Posted ${distance} ${dayWord} before the Hallix date.`
            : `Posted ${distance} ${dayWord} from the Hallix date, outside the ${options.dateToleranceDays}-day window.`,
        points: awarded,
      });
    }
  }

  if (vendorSimilarity >= vendorStrongSimilarity() || vendorContained) {
    points += SCORE_WEIGHTS.vendorStrong;
    reasons.push({
      code: "vendor_strong",
      label:
        vendorContained && vendorSimilarity < vendorStrongSimilarity()
          ? `The bank description contains the recorded vendor name${candidate.vendor ? ` "${candidate.vendor}"` : ""}, wrapped in the card processor's extra wording.`
          : `Vendor name is a strong match${candidate.vendor ? ` for "${candidate.vendor}"` : ""}.`,
      points: SCORE_WEIGHTS.vendorStrong,
    });
  } else if (vendorSimilarity >= VENDOR_PARTIAL_SIMILARITY) {
    points += SCORE_WEIGHTS.vendorPartial;
    reasons.push({
      code: "vendor_partial",
      label: `Vendor name partly matches${candidate.vendor ? ` "${candidate.vendor}"` : ""}.`,
      points: SCORE_WEIGHTS.vendorPartial,
    });
  } else if (vendorSimilarity >= VENDOR_WEAK_SIMILARITY) {
    points += SCORE_WEIGHTS.vendorWeak;
    reasons.push({
      code: "vendor_weak",
      label: "A few words in the description overlap the recorded vendor.",
      points: SCORE_WEIGHTS.vendorWeak,
    });
  }

  let hasStrongIdentifier = false;
  if (line.checkNumber && candidate.checkNumber && line.checkNumber === candidate.checkNumber) {
    points += SCORE_WEIGHTS.checkNumberExact;
    hasStrongIdentifier = true;
    reasons.push({
      code: "check_number_exact",
      label: `Check number ${line.checkNumber} matches exactly.`,
      points: SCORE_WEIGHTS.checkNumberExact,
    });
  }
  if (
    line.referenceNumber &&
    candidate.referenceNumber &&
    line.referenceNumber === candidate.referenceNumber
  ) {
    points += SCORE_WEIGHTS.referenceNumberExact;
    hasStrongIdentifier = true;
    reasons.push({
      code: "reference_number_exact",
      label: "Reference number matches exactly.",
      points: SCORE_WEIGHTS.referenceNumberExact,
    });
  }

  if (belongsToSelectedAccount(candidate, options.selectedAccountName)) {
    points += SCORE_WEIGHTS.sameBankAccount;
    reasons.push({
      code: "same_bank_account",
      label: "Recorded against the same bank account.",
      points: SCORE_WEIGHTS.sameBankAccount,
    });
  } else if (candidate.bankAccountName && options.selectedAccountName) {
    reasons.push({
      code: "different_bank_account",
      label: `Recorded against a different account ("${candidate.bankAccountName}").`,
      points: 0,
    });
  }

  return {
    expenseId: candidate.expenseId,
    score: clamp01(points / MAX_SCORE),
    reasons,
    exactAmount,
    amountDifferenceCents,
    likelyGratuity,
    directionMismatch,
    dayDelta,
    vendorSimilarity,
    vendorContained,
    hasStrongIdentifier,
  };
}

/**
 * How much of an inexact amount can be explained as a gratuity, or null when it
 * cannot be.
 *
 * A restaurant prints the receipt before the tip is written on it, so Hallix
 * holds the pre-tip figure and the bank holds the total. The allowance is
 * deliberately narrow: outflows only, the bank figure must be the larger of the
 * two, and the vendor and date have to agree already — otherwise this would pair
 * two unrelated charges that merely happen to be similar in size.
 */
function gratuityOverage(input: {
  lineCents: number;
  candidateCents: number;
  vendorConfirmed: boolean;
  withinDateTolerance: boolean;
}): number | null {
  if (!input.vendorConfirmed || !input.withinDateTolerance) return null;
  if (input.lineCents >= 0 || input.candidateCents >= 0) return null;

  const charged = Math.abs(input.lineCents);
  const recorded = Math.abs(input.candidateCents);
  if (charged <= recorded) return null;

  const overage = charged - recorded;
  if (overage > TIP_MAX_OVERAGE_CENTS) return null;
  if (overage > Math.round(recorded * tipToleranceRatio())) return null;
  return overage;
}

/** Explains why a proposal needs a human look rather than being applied. */
function reviewReasons(candidate: ScoredCandidate, toleranceDays: number): MatchReason[] {
  const reasons: MatchReason[] = [];
  if (candidate.directionMismatch) {
    reasons.push({
      code: "amount_sign_mismatch",
      label: "Confirm whether this is really a credit or a debit before matching.",
      points: 0,
    });
  }
  if (candidate.likelyGratuity) {
    reasons.push({
      code: "amount_tip",
      label:
        "Hallix will reconcile the amount the bank charged. Confirm the tip is right before matching.",
      points: 0,
    });
  } else if (!candidate.exactAmount) {
    reasons.push({
      code: "amount_direction",
      label: "The amounts differ, so this needs review before reconciling.",
      points: 0,
    });
  }
  if (candidate.dayDelta != null && Math.abs(candidate.dayDelta) > toleranceDays) {
    reasons.push({
      code: "date_outside_tolerance",
      label: `The dates are more than ${toleranceDays} days apart.`,
      points: 0,
    });
  }
  if (
    candidate.vendorSimilarity < vendorStrongSimilarity() &&
    !candidate.vendorContained &&
    !candidate.hasStrongIdentifier
  ) {
    reasons.push({
      code: "vendor_weak",
      label: "The vendor name, check number and reference number do not confirm this pairing.",
      points: 0,
    });
  }
  return reasons;
}

/**
 * Score the bank description against each Hallix name field separately and keep
 * the best signal. Concatenating payee + memo used to make containment demand
 * every memo word on the bank line.
 */
function bestVendorSignal(
  bankDescription: string,
  candidate: LedgerCandidate,
): { vendorSimilarity: number; vendorContained: boolean } {
  const names =
    candidate.matchNames?.length > 0
      ? candidate.matchNames
      : [candidate.normalizedText].filter(Boolean);

  let vendorSimilarity = 0;
  let vendorContained = false;
  for (const name of names) {
    if (containsVendorName(bankDescription, name)) vendorContained = true;
    vendorSimilarity = Math.max(vendorSimilarity, descriptionSimilarity(bankDescription, name));
  }
  return { vendorSimilarity, vendorContained };
}

function belongsToSelectedAccount(
  candidate: LedgerCandidate,
  selectedAccountName: string | null,
): boolean {
  if (!selectedAccountName) return true;
  const candidateName = candidate.bankAccountName?.trim().toLowerCase();
  // A transaction with no account recorded is treated as belonging to the account
  // being reconciled: departments frequently leave the field blank.
  if (!candidateName) return true;
  return candidateName === selectedAccountName.trim().toLowerCase();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function percentOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Human label for a match status, used by the review screen and summaries. */
export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  unmatched: "Missing from Hallix",
  auto_matched: "High-confidence match",
  possible_match: "Possible match — review",
  manually_matched: "Matched by you",
  ambiguous_duplicate: "Ambiguous — two candidates",
  already_reconciled: "Already reconciled",
  outside_period: "Outside statement period",
  not_applicable: "Not applicable",
};
