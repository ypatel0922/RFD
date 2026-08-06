export const ROLE_OPTIONS = [
  "Chief",
  "Captain",
  "Lieutenant",
  "Secretary",
  "Treasurer",
  "Other",
] as const;

export type RoleOption = (typeof ROLE_OPTIONS)[number];

export type Department = {
  id: string;
  name: string;
  setup_completed_at?: string | null;
};

export type DepartmentMembership = {
  department_id: string;
  role: string;
  departments: Department | null;
};

export type DepartmentSetting = {
  department_id: string;
  auto_log_statement_expenses: boolean;
  audit_trail_enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type BankAccount = {
  id: string;
  department_id: string;
  name: string;
  institution_name: string | null;
  account_mask: string | null;
  is_default: boolean;
  is_two_percent_account: boolean;
  fund_type: string | null;
  created_at: string;
  account_type?: string | null;
  last_reconciled_at?: string | null;
  last_reconciled_statement_end_date?: string | null;
  last_reconciled_ending_balance?: number | string | null;
};

export type BankStatementTransaction = {
  posted_date: string | null;
  description: string | null;
  amount: number | null;
  balance: number | null;
  reference: string | null;
};

export type BankStatementExtraction = {
  account_name: string | null;
  beginning_balance: number | null;
  ending_balance: number | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  transactions: BankStatementTransaction[];
  confidence: number;
  notes: string | null;
};

export type BankStatementUpload = {
  id: string;
  department_id: string;
  bank_account_name: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  beginning_balance: string | number | null;
  ending_balance: string | number | null;
  statement_file_path: string | null;
  original_filename: string | null;
  content_type: string | null;
  uploaded_by_user_id: string;
  uploaded_by_email: string;
  created_at: string;
};

export type ExpenseRecord = {
  id: string;
  department_id: string;
  receipt_id: string;
  receipt_path: string;
  original_filename: string;
  content_type: string;
  created_at: string;
  created_by_user_id: string;
  created_by_email: string;
  uploaded_by: string | null;
  fund: string | null;
  payment_reference: string | null;
  payee: string | null;
  description: string | null;
  bank_account_name: string | null;
  merchant_name: string | null;
  transaction_date: string | null;
  total_amount: string | number | null;
  tax_amount: string | number | null;
  balance_after_transaction: string | number | null;
  category: string | null;
  payment_method: string | null;
  extraction_status: "extracted" | "needs_review" | "failed";
  extraction_confidence: number;
  extraction_notes: string | null;
  reconciliation_status:
    | "pending_bank_match"
    | "unreconciled"
    | "matched"
    | "needs_attention";
  bank_transaction_id: string | null;
  bank_posted_date: string | null;
  bank_description: string | null;
  bank_amount: string | number | null;
  bank_match_confidence: number;
  reconciled_at: string | null;
  reconciliation_candidate: boolean | null;
  reconciliation_candidate_notes: string | null;
  reconciliation_similarity: number | null;
  last_manual_edit_reason: string | null;
  last_manual_edit_at: string | null;
  last_manual_edit_by: string | null;
  uses_two_percent_funds: boolean | null;
  two_percent_review_status: "likely_eligible" | "needs_review" | "potentially_not_allowed" | null;
  two_percent_warning_reason: string | null;
  member_vote_recorded: boolean | null;
  meeting_date: string | null;
  support_note: string | null;
};

export type ExtractedReceiptData = {
  merchant_name: string | null;
  payee: string | null;
  transaction_date: string | null;
  total_amount: string | null;
  tax_amount: string | null;
  payment_reference: string | null;
  description: string | null;
  bank_account_name: string | null;
  balance_after_transaction: string | null;
  category: string | null;
  payment_method: string | null;
  extraction_status: "extracted" | "needs_review" | "failed";
  confidence: number;
  notes: string | null;
};

export type ExpenseDraft = {
  id: string;
  receiptId: string;
  receiptFile: File;
  receiptPreviewUrl: string | null;
  receiptPath: string;
  createdAt: string;
  extracted: ExtractedReceiptData;
  fund: string;
};

export type ReviewForm = {
  fund: string;
  payment_reference: string;
  payee: string;
  description: string;
  bank_account_name: string;
  transaction_date: string;
  total_amount: string;
  tax_amount: string;
  balance_after_transaction: string;
  category: string;
  payment_method: string;
  uses_two_percent_funds: boolean;
  member_vote_recorded: boolean;
  meeting_date: string;
  support_note: string;
};

export type TaxFormFiling = {
  id: string;
  department_id: string;
  tax_form_type: string;
  tax_year: number;
  source: "generated_firebook" | "uploaded_prior_filing";
  status: "draft" | "saved" | "uploaded" | "archived";
  file_path: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  extracted_data: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ReconciliationReportRow = {
  expense: ExpenseRecord;
  section: "Cleared Transactions" | "New / Unmatched Transactions";
  reconciledOnReport: boolean;
};

export type ReconciliationReport = {
  departmentName: string;
  startDate: string;
  endDate: string;
  bankAccountName: string | null;
  rows: ReconciliationReportRow[];
  clearedRows: ReconciliationReportRow[];
  newRows: ReconciliationReportRow[];
  clearedTotal: number;
  newTotal: number;
  endingRegisterBalance: string | number | null;
};

export type DepartmentTaxProfile = {
  id?: string;
  department_id: string;
  department_name: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  entity_type: string | null;
  treasurer_name: string | null;
  treasurer_email: string | null;
  treasurer_phone: string | null;
  created_at?: string;
  updated_at?: string;
};

export type TaxFormRun = {
  id: string;
  department_id: string;
  tax_year: number;
  starting_balance: number;
  revenue_total: number;
  expense_total: number;
  ending_balance: number;
  generated_pdf: string | null;
  status: "draft" | "final";
  form_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type OnboardingProfile = {
  id: string;
  department_id: string;
  status: "not_started" | "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type OnboardingBeginningBalance = {
  id: string;
  department_id: string;
  account_id: string | null;
  account_name: string;
  account_type: string;
  institution: string | null;
  mask: string | null;
  beginning_balance: number;
  balance_date: string;
  is_default: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type OnboardingPriorRecordUpload = {
  id: string;
  department_id: string;
  file_path: string;
  file_name: string;
  file_mime_type: string | null;
  status: "uploaded" | "processing" | "reviewed" | "failed";
  extracted_data: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type OnboardingSuggestion = {
  id: string;
  department_id: string;
  suggestion_type: "account" | "category" | "vendor" | "income_type";
  suggested_value: string;
  confidence: number | null;
  source_upload_id: string | null;
  status: "pending" | "accepted" | "renamed" | "ignored";
  accepted_value: string | null;
  created_at: string;
  updated_at: string;
};

export type ReceiptRequestStatus = "pending" | "completed" | "expired" | "ignored" | "failed";

export type ReceiptRequest = {
  id: string;
  department_id: string;
  transaction_id: string;
  expense_id: string | null;
  user_id: string | null;
  phone_number: string;
  request_code: string;
  status: ReceiptRequestStatus;
  sent_at: string | null;
  completed_at: string | null;
  twilio_message_sid: string | null;
  inbound_message_sid: string | null;
  created_at: string;
  updated_at: string;
};

export type UserNotificationPrefs = {
  id: string;
  user_id: string;
  department_id: string;
  sms_receipt_requests_enabled: boolean;
  phone_number: string | null;
  created_at: string;
  updated_at: string;
};

export type CategoryGroup = "two_percent" | "general";
export type CategoryDefaultType = "expense" | "income" | "both";
export type TwoPercentGuidance =
  | "likely_eligible"
  | "needs_review"
  | "potentially_not_allowed"
  | "not_two_percent";

export type DepartmentCategory = {
  id: string;
  department_id: string;
  name: string;
  normalized_name: string;
  description: string | null;
  category_group: CategoryGroup;
  default_type: CategoryDefaultType;
  two_percent_guidance: TwoPercentGuidance;
  is_system_default: boolean;
  is_active: boolean;
  created_from: string | null;
  created_at: string;
  updated_at: string;
};

export type DepartmentVendor = {
  id: string;
  department_id: string;
  name: string;
  normalized_name: string;
  default_category: string | null;
  created_from: string | null;
  created_at: string;
  updated_at: string;
};
