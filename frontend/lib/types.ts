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
  created_at: string;
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
