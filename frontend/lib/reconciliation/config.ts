/**
 * Tunable limits and matching thresholds for statement reconciliation.
 *
 * Everything here is a deliberate accounting or product decision, so the values
 * live in one place rather than being scattered through the scoring code.
 */

/** Largest acceptable gap between the statement's own arithmetic and its
 * printed ending balance. One cent absorbs a bank's rounding of a fee or
 * interest accrual; anything larger means a row was misread or is missing. */
export const BALANCE_TOLERANCE_CENTS = 1;

/** Default window for matching a Hallix date to a bank posting date. A check
 * written on the 28th commonly posts in early the following month. */
export const DEFAULT_DATE_TOLERANCE_DAYS = 7;

export function dateToleranceDays(): number {
  const raw = process.env.RECONCILIATION_DATE_TOLERANCE_DAYS;
  if (!raw) return DEFAULT_DATE_TOLERANCE_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 45) {
    return DEFAULT_DATE_TOLERANCE_DAYS;
  }
  return Math.floor(parsed);
}

/**
 * Scoring weights. A candidate's raw points are divided by MAX_SCORE to give a
 * 0..1 score. Amount is worth the most because an exact cent match is the
 * strongest single signal; a strong identifier (check or reference number) is
 * worth nearly as much as the date and vendor combined.
 */
export const SCORE_WEIGHTS = {
  exactAmount: 45,
  sameDay: 25,
  dateWithinTwoDays: 21,
  dateWithinFourDays: 16,
  dateWithinTolerance: 10,
  vendorStrong: 20,
  vendorPartial: 12,
  vendorWeak: 5,
  checkNumberExact: 20,
  referenceNumberExact: 14,
  sameBankAccount: 5,
} as const;

/** Denominator for normalizing raw points into 0..1. */
export const MAX_SCORE =
  SCORE_WEIGHTS.exactAmount +
  SCORE_WEIGHTS.sameDay +
  SCORE_WEIGHTS.vendorStrong +
  SCORE_WEIGHTS.checkNumberExact +
  SCORE_WEIGHTS.sameBankAccount;

/** Minimum normalized score for an automatic high-confidence suggestion. */
export const AUTO_MATCH_MIN_SCORE = 0.72;

/** Minimum normalized score to show a line as a possible match needing review. */
export const POSSIBLE_MATCH_MIN_SCORE = 0.4;

/** The best candidate must beat the runner-up by this margin to auto-match. */
export const AUTO_MATCH_UNIQUENESS_MARGIN = 0.1;

/** Two top candidates within this margin are an ambiguous duplicate. */
export const AMBIGUOUS_MARGIN = 0.05;

/** Vendor similarity that counts as a supporting signal for an auto-match. */
export const VENDOR_STRONG_SIMILARITY = 0.62;
export const VENDOR_PARTIAL_SIMILARITY = 0.34;
export const VENDOR_WEAK_SIMILARITY = 0.18;

/**
 * Vendor-name tolerance, the naming counterpart to the date window above.
 *
 * A bank rarely prints the name a treasurer typed. "Employees Only" is billed as
 * "SQ *EMPLOYEES ONLY LLC NEW YORK NY", so the comparison is a similarity score,
 * not an equality test. Lower the bar to catch more loosely-named vendors, raise
 * it to demand closer wording.
 */
export function vendorStrongSimilarity(): number {
  const raw = process.env.RECONCILIATION_VENDOR_MATCH_MIN_SIMILARITY;
  if (!raw) return VENDOR_STRONG_SIMILARITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.3 || parsed > 0.95) {
    return VENDOR_STRONG_SIMILARITY;
  }
  return parsed;
}

/**
 * Amount tolerance for an ordinary near-miss: a cent of rounding, or a fee the
 * treasurer typed slightly differently. The larger of a dollar and one percent.
 */
export const AMOUNT_NEAR_TOLERANCE_CENTS = 100;
export const AMOUNT_NEAR_TOLERANCE_RATIO = 0.01;

/**
 * Gratuity tolerance. A restaurant prints the receipt before the tip is written
 * on it, so Hallix holds the pre-tip figure and the bank holds the total. Where
 * the vendor and date agree, a card charge up to this much larger than the
 * recorded amount is offered as a possible match for the treasurer to confirm —
 * never as an automatic one, because the amounts genuinely differ.
 */
export const DEFAULT_TIP_TOLERANCE_RATIO = 0.3;

/** Hard ceiling on the gratuity gap, so a large bill cannot pair loosely. */
export const TIP_MAX_OVERAGE_CENTS = 150_00;

export function tipToleranceRatio(): number {
  const raw = process.env.RECONCILIATION_TIP_TOLERANCE_PERCENT;
  if (!raw) return DEFAULT_TIP_TOLERANCE_RATIO;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return DEFAULT_TIP_TOLERANCE_RATIO;
  }
  return parsed / 100;
}

/** Upload/processing limits. Keeps one serverless request small and bounded. */
export const MAX_PAGES_PER_SESSION = 20;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_BYTES = 60 * 1024 * 1024;

/** Below this pixel area a phone photo cannot resolve statement text. */
export const MIN_PAGE_PIXELS = 300_000;
export const MIN_PAGE_EDGE_PIXELS = 500;

/** Concurrent page extraction requests from the browser. */
export const PAGE_UPLOAD_CONCURRENCY = 2;

/**
 * Longest edge kept when downscaling a phone photo. Statement body text is
 * roughly 8pt, so dropping below about 2000px on the long edge starts to close
 * up the digits in an amount column. Modern phones shoot 3000-4000px, so most
 * photos shrink by a third and stay comfortably readable.
 */
export const TARGET_MAX_EDGE_PIXELS = 2200;

/** JPEG quality for the downscaled page. High enough to keep thin digit strokes. */
export const PAGE_JPEG_QUALITY = 0.82;

/**
 * Sharpness floor, measured as the variance of a Laplacian over a grayscale
 * downscale. Blurry phone photos land near zero; a legible statement photo is
 * comfortably above this. Only ever raises a warning, never blocks a page,
 * because the number varies with paper colour and lighting.
 */
export const MIN_SHARPNESS_VARIANCE = 45;

/** Below this pixel-to-pixel spread the photo is a blank or near-blank frame. */
export const MIN_CONTENT_STDDEV = 6;

export const ACCEPTED_PAGE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

/** How long a draft survives before the cleanup job may remove it. */
export const DRAFT_RETENTION_DAYS = 30;

/**
 * Vision model used to read statement pages. Configurable so the model can be
 * changed without a code deploy, and so a department can pin a version.
 *
 * Default is `gpt-4.1`: statement pages are dense multi-column tables, often
 * photographed at an angle, and the cheaper receipt model (`gpt-4o-mini`) drops
 * rows and misreads amount columns on that work. Override with
 * `BANK_STATEMENT_VISION_MODEL` when a deployment needs a different pin.
 */
export function statementVisionModel(): string {
  return process.env.BANK_STATEMENT_VISION_MODEL?.trim() || "gpt-4.1";
}
