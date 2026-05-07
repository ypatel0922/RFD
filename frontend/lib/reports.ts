import type { ExpenseRecord, ReconciliationReport, ReconciliationReportRow } from "./types";

function inPeriod(expense: ExpenseRecord, startDate: string, endDate: string) {
  if (!expense.transaction_date) return true;
  return expense.transaction_date >= startDate && expense.transaction_date <= endDate;
}

function matchesBankAccount(expense: ExpenseRecord, bankAccountName: string) {
  if (!bankAccountName.trim()) return true;
  return expense.bank_account_name?.toLowerCase() === bankAccountName.trim().toLowerCase();
}

function isReconciledOnReport(expense: ExpenseRecord, endDate: string) {
  if (expense.reconciliation_status !== "matched") return false;
  const postedDate = expense.bank_posted_date || expense.transaction_date;
  return !postedDate || postedDate <= endDate;
}

function amount(expense: ExpenseRecord) {
  return Number(expense.total_amount || 0);
}

export function buildReconciliationReport({
  expenses,
  departmentName,
  startDate,
  endDate,
  bankAccountName,
}: {
  expenses: ExpenseRecord[];
  departmentName: string;
  startDate: string;
  endDate: string;
  bankAccountName: string;
}): ReconciliationReport {
  const filtered = expenses
    .filter((expense) => inPeriod(expense, startDate, endDate))
    .filter((expense) => matchesBankAccount(expense, bankAccountName))
    .sort((a, b) => {
      const dateCompare = (a.transaction_date || "").localeCompare(b.transaction_date || "");
      if (dateCompare !== 0) return dateCompare;
      return a.created_at.localeCompare(b.created_at);
    });

  const rows = filtered.map<ReconciliationReportRow>((expense) => {
    const reconciledOnReport = isReconciledOnReport(expense, endDate);
    return {
      expense,
      section: reconciledOnReport ? "Cleared Transactions" : "New / Unmatched Transactions",
      reconciledOnReport,
    };
  });

  const clearedRows = rows.filter((row) => row.reconciledOnReport);
  const newRows = rows.filter((row) => !row.reconciledOnReport);
  const balanceRows = filtered.filter((expense) => expense.balance_after_transaction != null);
  const latestBalance = balanceRows.at(-1)?.balance_after_transaction ?? null;

  return {
    departmentName,
    startDate,
    endDate,
    bankAccountName: bankAccountName.trim() || null,
    rows,
    clearedRows,
    newRows,
    clearedTotal: clearedRows.reduce((total, row) => total + amount(row.expense), 0),
    newTotal: newRows.reduce((total, row) => total + amount(row.expense), 0),
    endingRegisterBalance: latestBalance,
  };
}

function csvCell(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function reconciliationReportCsv(
  report: ReconciliationReport,
  receiptUrls: Record<string, string> = {},
) {
  const rows = [
    [
      "Section",
      "Type",
      "Date",
      "Num",
      "Name",
      "Reconciled on report",
      "Amount",
      "Balance",
      "Bank account",
      "Bank posted date",
      "Bank description",
      "Receipt",
    ],
    ...report.rows.map((row) => {
      const expense = row.expense;
      return [
        row.section,
        expense.payment_method || "Expense",
        expense.transaction_date || "",
        expense.payment_reference || "",
        expense.payee || expense.merchant_name || "",
        row.reconciledOnReport ? "Yes" : "No",
        expense.total_amount ?? "",
        expense.balance_after_transaction ?? "",
        expense.bank_account_name || "",
        expense.bank_posted_date || "",
        expense.bank_description || "",
        receiptUrls[expense.id] || expense.receipt_path,
      ];
    }),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
