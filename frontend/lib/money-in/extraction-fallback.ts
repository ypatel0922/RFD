import type { ExtractedMoneyInData } from "../types";

/** Empty, review-able extraction. Shared by the server route and the browser. */
export const EMPTY_MONEY_IN_EXTRACTION: ExtractedMoneyInData = {
  document_type: null,
  payer: null,
  amount: null,
  date: null,
  check_number: null,
  memo: null,
  payment_method: null,
  fund_designation: null,
  grant_reference: null,
  suggested_category: null,
  category_confidence: null,
  category_reason: null,
  suggest_two_percent: null,
  two_percent_confidence: null,
  two_percent_reason: null,
  extraction_status: "needs_review",
  confidence: 0,
  notes: null,
};

export const FALLBACK_MONEY_IN_EXTRACTION_CLIENT: ExtractedMoneyInData = {
  ...EMPTY_MONEY_IN_EXTRACTION,
  notes: "Hallix couldn't read this document automatically. Enter the payment details below.",
};
