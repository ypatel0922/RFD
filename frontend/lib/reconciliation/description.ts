/**
 * Bank description normalization.
 *
 * A bank prints "POS DEBIT 04/12 TRACTOR SUPPLY #1482 RIVERHEAD NY CARD 4471"
 * for what the treasurer wrote down as "Tractor Supply". Normalization strips
 * the channel noise, store numbers, truncated card digits and reference ids so
 * the two can be compared, while the original text is always preserved for
 * display and for the audit trail.
 */

/**
 * Channel/processing words banks prepend or append. These carry no information
 * about who was paid, so they are removed before comparison.
 */
const CHANNEL_TOKENS = new Set([
  "ach",
  "aut",
  "auth",
  "authorization",
  "card",
  "cardmember",
  "cash",
  "cbk",
  "check",
  "checkcard",
  "chk",
  "credit",
  "date",
  "debit",
  "deposit",
  "dep",
  "dda",
  "draft",
  "eft",
  "electronic",
  "epay",
  "epayment",
  "ext",
  "fee",
  "id",
  "indn",
  "internet",
  "merch",
  "merchant",
  "mobile",
  "online",
  "payment",
  "pmt",
  "pos",
  "ppd",
  "preauthorized",
  "purchase",
  "recurring",
  "ref",
  "reference",
  "seq",
  "svc",
  "tel",
  "trace",
  "tran",
  "transfer",
  "trn",
  "trnsfr",
  "web",
  "wire",
  "withdrawal",
  "wd",
  "xfer",
]);

/**
 * Payment-processor prefixes glued to the vendor name. Removing them exposes the
 * real merchant, e.g. "SQ *RIVERHEAD DINER" -> "riverhead diner".
 */
const PROCESSOR_PREFIXES = [
  /\bsq\s*\*/gi,
  /\btst\s*\*/gi,
  /\bpp\s*\*/gi,
  /\bpaypal\s*\*/gi,
  /\bsp\s*\*/gi,
  /\bwl\s*\*/gi,
  /\bin\s*\*/gi,
  /\buber\s*\*/gi,
  /\bdoordash\s*\*/gi,
  /\bamzn\s*mktp\b/gi,
  /\bamazon\s*mktpl?\b/gi,
];

/** Tokens that are pure noise: store numbers, card tails, long reference ids. */
function isNoiseToken(token: string): boolean {
  if (!token) return true;
  if (CHANNEL_TOKENS.has(token)) return true;
  // Bare numbers: store numbers, trace numbers, truncated card digits.
  if (/^\d+$/.test(token)) return true;
  // Mixed alphanumeric reference ids like "x1482" or "id4471".
  if (/^[a-z]{1,3}\d{3,}$/.test(token)) return true;
  // Long opaque identifiers.
  if (token.length >= 10 && /\d/.test(token) && /[a-z]/.test(token)) return true;
  return false;
}

const STATE_ABBREVIATIONS = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt",
  "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
  "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
]);

/**
 * Legal-entity words. A bank prints the registered name ("Employees Only LLC")
 * for what a receipt — and therefore the treasurer — calls the trading name
 * ("Employees Only"). Dropping these from both sides lets the two compare equal.
 */
const ENTITY_TOKENS = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "dba",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "pc",
  "plc",
  "pllc",
  "the",
]);

/**
 * Business-type words treasurers often append to a short trading name
 * ("Capo Restaurant", "Harbor Cafe") that a bank rarely prints. They must not
 * block containment when the distinctive name is clearly present.
 */
const GENERIC_BUSINESS_WORDS = new Set([
  "bar",
  "bistro",
  "cafe",
  "diner",
  "eatery",
  "grill",
  "group",
  "hotel",
  "house",
  "inn",
  "kitchen",
  "lounge",
  "market",
  "motel",
  "pub",
  "restaurant",
  "resto",
  "shop",
  "store",
  "tavern",
]);

/**
 * Produce the comparison form of a description. Lowercase, processor prefixes
 * removed, punctuation folded to spaces, noise tokens dropped, and a trailing
 * two-letter state abbreviation removed. Returns "" when nothing meaningful is
 * left, which callers treat as "no vendor signal" rather than a match.
 */
export function normalizeDescription(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = String(raw).toLowerCase();

  for (const pattern of PROCESSOR_PREFIXES) text = text.replace(pattern, " ");

  // Possessives: "employee's only" must compare equal to "employees only".
  text = text.replace(/['\u2018\u2019]s\b/g, "s");
  text = text.replace(/['\u2018\u2019]/g, "");

  // Inline dates banks embed mid-description ("pos debit 04/12 ...").
  text = text.replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ");
  // Masked card numbers in any of the common shapes.
  text = text.replace(/\b[x*#]{2,}\d{2,}\b/g, " ");
  text = text.replace(/\b\d{4}[x*]{4,}\d{0,4}\b/g, " ");
  text = text.replace(/[^a-z0-9]+/g, " ");

  const tokens = text.split(" ").filter(Boolean).filter((token) => !isNoiseToken(token));

  // Keep the entity words when they are all there is, so a payee recorded as
  // "The Company" is not erased.
  const withoutEntityWords = tokens.filter((token) => !ENTITY_TOKENS.has(token));
  const kept = withoutEntityWords.length ? withoutEntityWords : tokens;

  // A trailing state code is location noise, but only drop it when other words
  // remain, so a description of just "NY" is not erased.
  while (kept.length > 1 && STATE_ABBREVIATIONS.has(kept[kept.length - 1])) {
    kept.pop();
  }

  return kept.join(" ").trim();
}

/**
 * Whether the recorded vendor name is recognizably present inside a bank
 * description. This is the "SQ *EMPLOYEES ONLY LLC NEW YORK NY" / "TST* CAPO
 * SOUTH BOSTON" case: the bank wraps or shortens the trading name, so a blended
 * similarity score gets diluted even though the name is plainly there.
 *
 * Both arguments must already be normalized. Generic business words the
 * treasurer typed ("Restaurant", "Cafe") are optional. Soft plural matching
 * treats "employee" and "employees" as the same word.
 */
export function containsVendorName(bankDescription: string, vendorName: string): boolean {
  const needle = [...tokenSet(vendorName)];
  if (!needle.length) return false;

  const haystack = tokenSet(bankDescription);
  if (!haystack.size) return false;

  const distinctive = needle.filter(
    (token) => token.length >= 3 && !GENERIC_BUSINESS_WORDS.has(token),
  );
  const required = distinctive.length
    ? distinctive
    : needle.filter((token) => token.length >= 3);
  if (!required.length) return false;

  return required.every((token) => tokenInSet(haystack, token));
}

/** Exact or soft-plural membership in a token set. */
function tokenInSet(tokens: Set<string>, token: string): boolean {
  if (tokens.has(token)) return true;
  if (token.length < 3) return false;

  if (token.endsWith("s") && tokens.has(token.slice(0, -1))) return true;
  if (!token.endsWith("s") && tokens.has(`${token}s`)) return true;
  if (token.endsWith("ies") && tokens.has(`${token.slice(0, -3)}y`)) return true;
  if (token.endsWith("y") && tokens.has(`${token.slice(0, -1)}ies`)) return true;
  return false;
}

/**
 * Check number written into the description, e.g. "CHECK 1042" or "CK#1042".
 * Returns the digits without leading zeros so "0042" and "42" compare equal.
 */
export function extractCheckNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw);
  const match =
    text.match(
      /\b(?:check|cheque|chk|ck)\s*(?:number|num|no|nbr|#)?\.?\s*[:#]?\s*(\d{2,8})\b/i,
    ) || text.match(/^\s*#\s*(\d{2,8})\b/);
  if (!match) return null;
  return normalizeCheckNumber(match[1]);
}

export function normalizeCheckNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const trimmed = digits.replace(/^0+/, "");
  return trimmed || "0";
}

/**
 * Reference-ish identifiers (ACH trace, card auth, wire ref, confirmation
 * numbers). Compared case-insensitively with separators removed so
 * "REF# ABC-1234" and "ref abc1234" match.
 */
export function normalizeReferenceNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 4) return null;
  return cleaned;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 1));
}

/**
 * Similarity in [0,1] between two normalized descriptions.
 *
 * Blends token overlap (Jaccard, which handles reordered words) with a
 * containment bonus (a short ledger vendor appearing inside a long bank
 * description) and a character-bigram score (which tolerates the odd OCR
 * character error). Deterministic and cheap -- no model call.
 */
export function descriptionSimilarity(left: string, right: string): number {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
  const union = aTokens.size + bTokens.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  const smaller = aTokens.size <= bTokens.size ? aTokens : bTokens;
  const containment = smaller.size === 0 ? 0 : intersection / smaller.size;

  const bigram = bigramSimilarity(a, b);

  // Containment is weighted heavily because ledger vendors are short names and
  // bank descriptions are long strings that embed them.
  return clamp01(0.35 * jaccard + 0.45 * containment + 0.2 * bigram);
}

function bigrams(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, "");
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < compact.length; index += 1) {
    const pair = compact.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  return counts;
}

function bigramSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of a.values()) totalA += count;
  for (const count of b.values()) totalB += count;
  for (const [pair, count] of a) {
    const other = b.get(pair);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (totalA + totalB);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Rows that look like transactions to a vision model but are not: repeated page
 * headers, column titles, subtotal rows, and balance-forward markers.
 */
const NON_TRANSACTION_PATTERNS: RegExp[] = [
  /^balance\s+(forward|brought\s+forward|carried\s+forward)$/,
  /^(beginning|opening|previous|prior)\s+balance$/,
  /^(ending|closing|new|current)\s+balance$/,
  /^(statement\s+)?balance$/,
  /^total\s+(deposits?|credits?|withdrawals?|debits?|checks?|fees?|additions?|subtractions?)/,
  /^(sub)?totals?$/,
  /^continued(\s+on\s+next\s+page)?$/,
  /^continued\s+from\s+previous\s+page$/,
  // A column-header row, whether the model read one heading or the whole strip
  // of them ("Date Description Amount Balance"). Deliberately excludes bare
  // "Deposit" / "Withdrawal" — those are common full descriptions of real
  // postings, and section titles like "Deposits and Other Credits" are covered
  // by the patterns below.
  /^(?:posted?\s*date|transaction\s*date|value\s*date|date|description|details|memo|reference|amount|balance|checks?\s*(?:no|num|number|#)?|no|#)(?:\s+(?:posted?\s*date|transaction\s*date|value\s*date|date|description|details|memo|reference|amount|balance|deposits?|withdrawals?|additions?|subtractions?|credits?|debits?|checks?\s*(?:no|num|number|#)?|no|#))*$/,
  /^daily\s+(ending\s+)?balance/,
  /^average\s+(daily\s+)?balance/,
  /^page\s+\d+(\s+of\s+\d+)?$/,
  /^account\s+(number|summary|activity)/,
  /^statement\s+(period|date|of\s+account)/,
  /^member\s*fdic$/,
  /^(deposits?\s+and\s+)(other\s+)?(additions?|credits?)$/,
  /^(withdrawals?\s+and\s+)(other\s+)?(subtractions?|debits?)$/,
  /^(other\s+)?(additions?|credits?|subtractions?|debits?)$/,
  /^checks?\s+(paid|presented|cleared)$/,
  // Do NOT treat bare "Deposit" / "Withdrawal" / "Electronic Withdrawal" as
  // structural — those are common full descriptions of real bank postings.
  /^service\s+charge\s+summary$/,
  /^interest\s+summary$/,
  /^year[\s-]?to[\s-]?date/,
  /^customer\s+service/,
  /^questions?\?/,
  /^how\s+to\s+balance/,
];

/**
 * True when a row is structural rather than a posted transaction.
 * Runs on the *raw printed* description so heading text is still intact.
 */
export function looksLikeNonTransactionRow(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const text = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return true;
  return NON_TRANSACTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when a row is a description continuation rather than its own
 * transaction: no amount, no date, and short trailing text such as an address
 * or a "INDN:" line that wrapped from the row above.
 */
export function looksLikeWrappedContinuation(row: {
  postedDate: string | null;
  transactionDate: string | null;
  signedAmountCents: number | null;
  originalDescription: string | null;
  runningBalanceCents: number | null;
}): boolean {
  if (row.signedAmountCents != null) return false;
  if (row.runningBalanceCents != null) return false;
  if (row.postedDate || row.transactionDate) return false;
  const text = (row.originalDescription || "").trim();
  if (!text) return false;
  return text.length <= 90;
}
