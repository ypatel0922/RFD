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
};

export type DepartmentMembership = {
  department_id: string;
  role: string;
  departments: Department | null;
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
  uploadedBy: string;
  fund: string;
};

export type ReviewForm = {
  uploaded_by: string;
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
