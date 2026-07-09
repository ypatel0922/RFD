/**
 * NYS 2% Foreign Fire Insurance Fund compliance guidance rules.
 *
 * Based on the NYS Two Percent Manual (2024 Edition). Hallix uses these rules
 * to suggest whether an expense is likely appropriate, needs review, or is
 * potentially not appropriate for 2% funds.
 *
 * IMPORTANT: This is guidance only. All final decisions should be confirmed
 * with your department policy, meeting minutes, and legal/financial counsel
 * as needed.
 */

import { TWO_PERCENT_CATEGORY_BANK } from "./category-seed";

export type TwoPercentStatus =
  | "likely_eligible"
  | "needs_review"
  | "potentially_not_allowed";

export interface TwoPercentEvaluation {
  status: TwoPercentStatus;
  reason: string;
}

// ── Likely Eligible ──────────────────────────────────────────────────────────
// Expenses commonly described as appropriate uses in the manual.

const LIKELY_ELIGIBLE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /fasny\s*(dues?|membership|fee)/i, label: "FASNY membership dues for all members" },
  { pattern: /membership\s*dues?/i, label: "Membership dues benefiting all members" },
  { pattern: /meeting\s*(food|refresh|meal|snack|lunch|dinner|breakfast)/i, label: "Meeting food and refreshments" },
  { pattern: /(food|refresh|meal|snack|lunch|dinner|breakfast)\s*(after|drill|fire|training)/i, label: "Food/refreshments after a fire or drill" },
  { pattern: /(drill|fire|training)\s*(food|meal|refresh)/i, label: "Food/refreshments after fire or drill" },
  { pattern: /(picnic|parade\s*banquet|banquet|christmas\s*party|holiday\s*party|annual\s*(dinner|party|banquet))/i, label: "Member picnic, parade, or annual event" },
  { pattern: /dress\s*uniform/i, label: "Dress/parade uniforms" },
  { pattern: /parade\s*uniform/i, label: "Parade uniforms" },
  { pattern: /(uniform|clothing)\s*(member|fire|depart)/i, label: "Member uniforms or clothing" },
  { pattern: /(uniform|t-shirt|polo|jacket)\s*(embroid|logo|depart)/i, label: "Department uniforms or branded clothing" },
  { pattern: /group\s*(life|disability|vision|health)\s*insur/i, label: "Group insurance for members" },
  { pattern: /member\s*insur/i, label: "Member insurance" },
  { pattern: /office\s*equipment/i, label: "Office equipment" },
  { pattern: /furniture/i, label: "Member room furniture" },
  { pattern: /(television|tv|appliance|refrigerator|microwave|coffee\s*maker|air\s*condi)/i, label: "Member lounge/kitchen appliance" },
  { pattern: /radio/i, label: "Radios for member use" },
  { pattern: /newsletter/i, label: "Department newsletter publication" },
  { pattern: /fasny\s*(firefighter.?s?\s*home|home\s*gift)/i, label: "FASNY Firefighter's Home donation" },
  { pattern: /attorney|auditor|accounting|administrative\s*service/i, label: "Attorney/auditor/administrative services for 2% fund" },
  { pattern: /(invest|certificate\s*of\s*deposit|cd|money\s*market|treasury)/i, label: "Prudent investment of 2% funds" },
  { pattern: /(convention|conference)\s*(attend|register|fee|travel)/i, label: "Convention or conference attendance" },
  { pattern: /(training\s*facility|firemen.?s?\s*park|park\s*(improve|construct|repair))/i, label: "Firemen's park or training facility improvement" },
  { pattern: /kitchen\s*(remodel|renovate|improve|install)/i, label: "Firehouse kitchen remodel for member use" },
  { pattern: /firehouse\s*(improve|renovate|remodel|repair)/i, label: "Firehouse improvement for member use" },
  { pattern: /(member\s*room|lounge\s*(improve|renovate|furnish))/i, label: "Member room improvement" },
];

// ── Potentially Not Allowed ───────────────────────────────────────────────────
// Expenses commonly described as improper or problematic uses in the manual.

const POTENTIALLY_NOT_ALLOWED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /cash\s*(payment|disbursement|advance|to\s*(member|firefighter|employee))/i, label: "Direct cash payments to members or firefighters" },
  { pattern: /(direct\s*)?payment\s*to\s*(member|firefighter|volunteer)/i, label: "Direct payment to individual members" },
  { pattern: /vehicle\s*registr/i, label: "Vehicle registration (municipal obligation)" },
  { pattern: /personal\s*vehicle\s*reimburse/i, label: "Personal vehicle reimbursement" },
  { pattern: /auto\s*registr/i, label: "Auto registration reimbursement" },
  { pattern: /donat(e|ion)\s*(to\s*)?(outside|other|another)\s*(fire\s*)?(dep|corp|company)/i, label: "Donation to outside fire department or corporation" },
  { pattern: /interest.?free\s*loan/i, label: "Interest-free loan to members" },
  { pattern: /loan\s*to\s*(member|individual|firefighter)/i, label: "Loan to individual member" },
  { pattern: /losap/i, label: "LOSAP or service award program funding" },
  { pattern: /service\s*award\s*program/i, label: "Service award program (LOSAP)" },
  { pattern: /donat(e|ion)\s*(to\s*)?(benevolent|charity|outside)/i, label: "Donation to outside benevolent association" },
  { pattern: /(salary|wage|compensation)\s*(secretary|treasurer|officer)/i, label: "Salary to secretary/treasurer (unless for 2% fund administration only)" },
  { pattern: /fire\s*prevention\s*week/i, label: "Fire Prevention Week poster/essay prize" },
  { pattern: /halloween\s*party/i, label: "Halloween party for all district children" },
  { pattern: /(christmas|holiday)\s*party\s*(for\s*)?(child|district|public|all\s*child)/i, label: "Public holiday party for all district children" },
  { pattern: /award\s*(most\s*active|outstanding\s*member|best)/i, label: "Award for most active firefighter (individual)" },
  { pattern: /disaster\s*(victim|relief)\s*medical/i, label: "Disaster victim temporary medical aid" },
  { pattern: /(municipal|town|city|county)\s*(charge|obligation|debt|fee)/i, label: "Municipal obligations normally paid by the AHJ" },
  { pattern: /special\s*school\s*(fire|department|training)/i, label: "Special schools for fire department services" },
  { pattern: /(compensat|pay)\s*(officer|employee)\s*(for|extra|bonus)/i, label: "Compensation to officers/employees" },
];

// ── Category-level guidance ───────────────────────────────────────────────────
// Maps known category strings to a default 2% status.

const CATEGORY_STATUS: Array<{ pattern: RegExp; status: TwoPercentStatus; label: string }> = [
  // Likely eligible
  { pattern: /^food$|^meal|^refreshment/i, status: "likely_eligible", label: "Food/refreshments (member meetings/events)" },
  { pattern: /^uniform|^dress uniform|^parade uniform/i, status: "likely_eligible", label: "Uniforms" },
  { pattern: /^office\s*equipment/i, status: "likely_eligible", label: "Office equipment" },
  { pattern: /^membership\s*dues?|^fasny/i, status: "likely_eligible", label: "Membership dues" },
  { pattern: /^(group\s*)?insur/i, status: "likely_eligible", label: "Insurance (group)" },
  { pattern: /^(invest|cd|treasury)/i, status: "likely_eligible", label: "Prudent investment" },
  { pattern: /^newsletter/i, status: "likely_eligible", label: "Newsletter" },
  { pattern: /^(attorney|audit|legal|accounting)/i, status: "likely_eligible", label: "Professional services for 2% administration" },
  { pattern: /^furniture|^appliance/i, status: "likely_eligible", label: "Member room furniture/appliances" },
  // Needs review
  { pattern: /^training|^education/i, status: "needs_review", label: "Training (verify it benefits members as a whole, not just fire services)" },
  { pattern: /^equipment\s*(purchase|repair|maintain)/i, status: "needs_review", label: "Equipment (verify it's for member use, not fire department operations)" },
  { pattern: /^convention|^conference/i, status: "needs_review", label: "Convention/conference (verify connection to 2% fund administration)" },
  { pattern: /^donation/i, status: "needs_review", label: "Donation (verify recipient and purpose are appropriate)" },
  // Potentially not allowed
  { pattern: /^losap|^service\s*award/i, status: "potentially_not_allowed", label: "LOSAP/service award program" },
  { pattern: /^cash\s*advance|^cash\s*payment/i, status: "potentially_not_allowed", label: "Cash payment/advance to member" },
  { pattern: /^vehicle|^auto\s*registr/i, status: "potentially_not_allowed", label: "Vehicle-related payment (municipal obligation)" },
  { pattern: /^salary|^wage|^payroll/i, status: "potentially_not_allowed", label: "Salary/wages (2% may only fund administration tasks)" },
];

// ── Core evaluation function ──────────────────────────────────────────────────

/**
 * Evaluate whether an expense is likely eligible, needs review, or potentially
 * not allowed for 2% funds based on vendor/category/description text.
 *
 * Returns guidance only — not a legal determination.
 *
 * Returns null when there is not enough information to classify the expense
 * OR when the expense does not match any known pattern. In that case, no flag
 * is set — we do NOT flag "needs review" merely because an expense is
 * unrecognized or because optional support fields are blank.
 */
export function evaluateTwoPercentStatus(params: {
  vendor?: string | null;
  category?: string | null;
  description?: string | null;
}): TwoPercentEvaluation | null {
  const text = [params.vendor, params.category, params.description]
    .filter(Boolean)
    .join(" ")
    .trim();

  // If no evaluable text is present, return null (do not flag).
  if (!text) {
    return null;
  }

  // Check potentially not allowed first (highest risk)
  for (const rule of POTENTIALLY_NOT_ALLOWED_PATTERNS) {
    if (rule.pattern.test(text)) {
      return {
        status: "potentially_not_allowed",
        reason: rule.label,
      };
    }
  }

  // Then check likely eligible
  for (const rule of LIKELY_ELIGIBLE_PATTERNS) {
    if (rule.pattern.test(text)) {
      return {
        status: "likely_eligible",
        reason: rule.label,
      };
    }
  }

  // Category-level fallback — only flags explicitly known categories
  if (params.category) {
    for (const rule of CATEGORY_STATUS) {
      if (rule.pattern.test(params.category)) {
        return { status: rule.status, reason: rule.label };
      }
    }
  }

  // No pattern matched — return null rather than defaulting to "needs_review".
  // A 2% transaction that doesn't match any pattern is simply unclassified,
  // not a problem. The user can review it at their discretion.
  return null;
}

// ── Category 2% eligibility preset lookup ────────────────────────────────────

/**
 * Returns the default 2% status for a given category name, or null if unknown.
 * Used by the Settings → Categories section to pre-populate eligibility.
 */
export function categoryTwoPercentStatus(
  category: string,
  departmentCategories?: Array<{ normalized_name: string; two_percent_guidance: string }>,
): TwoPercentStatus | null {
  if (departmentCategories?.length) {
    const normalized = category.trim().toLowerCase().replace(/\s+/g, " ");
    const match = departmentCategories.find((c) => c.normalized_name === normalized);
    if (match) {
      if (
        match.two_percent_guidance === "likely_eligible" ||
        match.two_percent_guidance === "needs_review" ||
        match.two_percent_guidance === "potentially_not_allowed"
      ) {
        return match.two_percent_guidance;
      }
      return null;
    }
  }
  for (const rule of CATEGORY_STATUS) {
    if (rule.pattern.test(category)) return rule.status;
  }
  return null;
}

// ── Vendor-to-2%-category direct mapping ─────────────────────────────────────
// Used to suggest the right 2% category from a vendor name or description.

const VENDOR_TO_TWO_PCT_CATEGORY: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /fasny/i, category: "FASNY Dues" },
  { pattern: /membership\s*dues?/i, category: "FASNY Dues" },
  { pattern: /meeting.*(?:food|refresh|meal|snack|lunch|dinner|breakfast)/i, category: "Meeting Food" },
  { pattern: /(?:food|refresh|meal|snack|lunch|dinner|breakfast).*(?:drill|fire|training)/i, category: "Drill Food" },
  { pattern: /(?:drill|fire|training).*(?:food|refresh|meal)/i, category: "Drill Food" },
  { pattern: /(?:picnic|banquet|annual\s*(?:dinner|party|banquet)|christmas\s*party|holiday\s*party|parade\s*banquet)/i, category: "Member Events" },
  { pattern: /(?:dress|parade)\s*uniform/i, category: "Parade Uniforms" },
  { pattern: /\buniform\b/i, category: "Parade Uniforms" },
  { pattern: /(?:group|member)\s*(?:life|disability|vision|health)\s*insur/i, category: "Group Insurance" },
  { pattern: /(?:group|member)\s*insur/i, category: "Group Insurance" },
  { pattern: /office\s*equip/i, category: "Office Equipment" },
  { pattern: /furniture/i, category: "Member Room" },
  { pattern: /(?:television|\btv\b|appliance|refrigerator|microwave|air\s*condi)/i, category: "Member Room" },
  { pattern: /\bradio\b/i, category: "Member Room" },
  { pattern: /newsletter/i, category: "Newsletter" },
  { pattern: /firefighter.?s?\s*home/i, category: "FASNY Home Gift" },
  { pattern: /(?:attorney|auditor|accountant|accounting|legal\s*(?:fee|service))/i, category: "Legal & Admin" },
  { pattern: /(?:convention|conference)/i, category: "Conferences" },
  { pattern: /(?:training\s*facility|firemen.?s?\s*park|park\s*(?:improve|construct|repair))/i, category: "Training Park" },
  { pattern: /kitchen\s*(?:remodel|renovate|improve|install)/i, category: "Firehouse Improvements" },
  { pattern: /firehouse\s*(?:improve|renovate|remodel|repair)/i, category: "Firehouse Improvements" },
  { pattern: /member\s*room/i, category: "Member Room" },
  { pattern: /(?:invest|certificate.*deposit|money\s*market|treasury)/i, category: "2% Investments" },
  { pattern: /\bnys\b|dfs|foreign\s*fire|2\s*%\s*deposit/i, category: "NYS 2% Deposit" },
  { pattern: /interest\s*(?:credit|earned|income)/i, category: "2% Interest" },
];

/**
 * Suggest the most likely 2% fund category for a vendor name or description.
 * Returns a category string, or null if nothing matches.
 *
 * Used to auto-suggest the category when a 2% expense is being logged
 * and there is no prior transaction history for the vendor.
 */
export function suggestTwoPctCategory(vendor: string, description?: string | null): string | null {
  const text = [vendor, description].filter(Boolean).join(" ").trim();
  if (!text) return null;
  for (const { pattern, category } of VENDOR_TO_TWO_PCT_CATEGORY) {
    if (pattern.test(text)) return category;
  }
  return null;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export const TWO_PERCENT_STATUS_LABELS: Record<TwoPercentStatus, string> = {
  likely_eligible: "Likely 2% Eligible",
  needs_review: "Needs Review",
  potentially_not_allowed: "Potentially Not Allowed",
};

export const TWO_PERCENT_STATUS_CLASS: Record<TwoPercentStatus, string> = {
  likely_eligible: "fb-2pct-badge--eligible",
  needs_review: "fb-2pct-badge--review",
  potentially_not_allowed: "fb-2pct-badge--warn",
};

export const TWO_PERCENT_DISCLAIMER =
  "Hallix provides guidance based on NYS 2% fund materials. Confirm final decisions with your department policy, meeting minutes, and counsel if needed.";

// ── Suggested categories list ─────────────────────────────────────────────────

export const TWO_PERCENT_SUGGESTED_CATEGORIES: Array<{
  name: string;
  status: TwoPercentStatus;
  note?: string;
}> = TWO_PERCENT_CATEGORY_BANK.map((seed) => ({
  name: seed.name,
  status: seed.two_percent_guidance as TwoPercentStatus,
  note:
    seed.two_percent_guidance === "needs_review" ? seed.description : undefined,
}));
