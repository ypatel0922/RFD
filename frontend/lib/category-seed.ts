/**
 * NYS 2% category bank — short display names with full detail in descriptions.
 * Only allowed categories (likely eligible + needs review). Disallowed uses are
 * not listed; users can type manually or use "Other 2% Expense".
 */

import type { CategoryDefaultType, CategoryGroup, TwoPercentGuidance } from "./types";

export type CategorySeed = {
  key: string;
  name: string;
  description: string;
  category_group: CategoryGroup;
  default_type: CategoryDefaultType;
  two_percent_guidance: TwoPercentGuidance;
  /** Shown in dropdowns on first load without adding from bank. */
  starter?: boolean;
};

/** Always visible in 2% dropdowns. */
export const TWO_PERCENT_STARTER_NORMALIZED = new Set([
  "other 2% expense",
  "nys 2% deposit",
  "2% interest",
  "other 2% income",
]);

export const OTHER_2PCT_EXPENSE = "Other 2% Expense";

export const TWO_PERCENT_CATEGORY_BANK: CategorySeed[] = [
  // Likely eligible
  { key: "fasny_dues", name: "FASNY Dues", description: "FASNY membership dues benefiting all members", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "meeting_food", name: "Meeting Food", description: "Food and refreshments for member meetings", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "drill_food", name: "Drill Food", description: "Food and refreshments after fires or drills", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "member_events", name: "Member Events", description: "Member picnics, banquets, parades, and annual events", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "parade_uniforms", name: "Parade Uniforms", description: "Dress and parade uniforms for members", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "member_room", name: "Member Room", description: "Furniture and appliances for member lounge or room", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "group_insurance", name: "Group Insurance", description: "Group life, disability, vision, or health insurance for members", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "office_equipment", name: "Office Equipment", description: "Office equipment for 2% fund administration", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "training_park", name: "Training Park", description: "Firemen's park or training facility improvements", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "firehouse_improvements", name: "Firehouse Improvements", description: "Kitchen or member-use area improvements", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "newsletter", name: "Newsletter", description: "Department newsletter publication costs", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "fasny_home_gift", name: "FASNY Home Gift", description: "Gift to FASNY Firefighter's Home", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "legal_admin", name: "Legal & Admin", description: "Attorney, auditor, and administrative services for 2% fund", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "investments", name: "2% Investments", description: "Prudent investment of 2% balances (CDs, treasury, money market)", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "conferences", name: "Conferences", description: "Convention or conference attendance for 2% administration", category_group: "two_percent", default_type: "expense", two_percent_guidance: "likely_eligible" },
  { key: "nys_deposit", name: "NYS 2% Deposit", description: "Foreign fire insurance premium deposits from NYS DFS", category_group: "two_percent", default_type: "income", two_percent_guidance: "likely_eligible", starter: true },
  { key: "interest", name: "2% Interest", description: "Interest earned on 2% fund balances", category_group: "two_percent", default_type: "income", two_percent_guidance: "likely_eligible", starter: true },
  { key: "other_income", name: "Other 2% Income", description: "Other income to the 2% fund", category_group: "two_percent", default_type: "income", two_percent_guidance: "likely_eligible", starter: true },
  // Needs review
  { key: "training", name: "Training", description: "Training or education — verify it benefits all members, not fire operations", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "equipment", name: "Equipment", description: "Equipment purchase — verify member use, not fire department operations", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "firehouse_work", name: "Firehouse Work", description: "Firehouse improvement — verify it is for member use", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "donation", name: "Donation", description: "Donation — verify recipient and member vote if required", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "public_events", name: "Public Events", description: "Events open to non-members — may need review", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "municipal", name: "Municipal Expense", description: "Municipal-type expenses normally paid by the AHJ", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review" },
  { key: "other_expense", name: OTHER_2PCT_EXPENSE, description: "Other 2% expenditure — use when no other category fits or item needs review", category_group: "two_percent", default_type: "expense", two_percent_guidance: "needs_review", starter: true },
];

/** Old long names → new short names (for migrating existing DB rows). */
export const LEGACY_TWO_PERCENT_RENAMES: Record<string, string> = {
  "fasny membership dues": "FASNY Dues",
  "meeting food & refreshments": "Meeting Food",
  "fire/drill refreshments": "Drill Food",
  "member picnic / banquet / parade": "Member Events",
  "dress & parade uniforms": "Parade Uniforms",
  "member room furniture & appliances": "Member Room",
  "group life / disability / vision insurance": "Group Insurance",
  "firemen's park / training facility": "Training Park",
  "firehouse kitchen / member use improvements": "Firehouse Improvements",
  "newsletter costs": "Newsletter",
  "fasny firefighter's home gift": "FASNY Home Gift",
  "attorney / auditor / administrative services": "Legal & Admin",
  "prudent investment of 2% funds": "2% Investments",
  "convention / conference attendance": "Conferences",
  "interest on 2% funds": "2% Interest",
  "training / education": "Training",
  "equipment purchase": "Equipment",
  "firehouse improvement": "Firehouse Work",
  "event with non-members": "Public Events",
  "municipal-type expense": "Municipal Expense",
};

export const GENERAL_CATEGORY_SEEDS: Omit<CategorySeed, "key">[] = [
  { name: "Food", description: "General food and meal expenses", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Fuel", description: "Fuel and gas expenses", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Office Supplies", description: "Office and administrative supplies", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "PPE & Uniforms", description: "Protective gear and operational uniforms", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Training", description: "Training and education expenses", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Travel", description: "Travel and lodging", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Repairs & Maintenance", description: "Repairs and maintenance", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Dues", description: "General dues and fees", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Donations", description: "Charitable donations", category_group: "general", default_type: "expense", two_percent_guidance: "not_two_percent" },
  { name: "Fundraising Income", description: "Income from fundraising events", category_group: "general", default_type: "income", two_percent_guidance: "not_two_percent" },
  { name: "Member Dues", description: "Member dues collected", category_group: "general", default_type: "income", two_percent_guidance: "not_two_percent" },
  { name: "Miscellaneous", description: "Miscellaneous transactions", category_group: "general", default_type: "both", two_percent_guidance: "not_two_percent" },
];
