from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.models import ExpenseRecord


@dataclass(frozen=True)
class ReconciliationReportRow:
    expense: ExpenseRecord
    section: str
    reconciled_on_report: bool


@dataclass(frozen=True)
class ReconciliationReport:
    department_name: str
    period_start: date
    period_end: date
    bank_account_name: str | None
    cleared_rows: list[ReconciliationReportRow]
    new_rows: list[ReconciliationReportRow]
    cleared_total: Decimal
    new_total: Decimal
    ending_register_balance: Decimal | None

    @property
    def cleared_count(self) -> int:
        return len(self.cleared_rows)

    @property
    def new_count(self) -> int:
        return len(self.new_rows)

    @property
    def rows(self) -> list[ReconciliationReportRow]:
        return [*self.cleared_rows, *self.new_rows]


def build_reconciliation_report(
    *,
    expenses: list[ExpenseRecord],
    department_name: str,
    period_start: date,
    period_end: date,
    bank_account_name: str | None = None,
) -> ReconciliationReport:
    report_expenses = [
        expense
        for expense in expenses
        if _in_period(expense, period_start, period_end)
        and _matches_bank_account(expense, bank_account_name)
    ]
    report_expenses.sort(key=lambda expense: (expense.transaction_date or date.min, expense.created_at))

    cleared_rows: list[ReconciliationReportRow] = []
    new_rows: list[ReconciliationReportRow] = []
    for expense in report_expenses:
        reconciled_on_report = _is_reconciled_on_report(expense, period_end)
        row = ReconciliationReportRow(
            expense=expense,
            section="Cleared Transactions" if reconciled_on_report else "New / Unmatched Transactions",
            reconciled_on_report=reconciled_on_report,
        )
        if reconciled_on_report:
            cleared_rows.append(row)
        else:
            new_rows.append(row)

    return ReconciliationReport(
        department_name=department_name,
        period_start=period_start,
        period_end=period_end,
        bank_account_name=bank_account_name,
        cleared_rows=cleared_rows,
        new_rows=new_rows,
        cleared_total=_sum_amounts(row.expense for row in cleared_rows),
        new_total=_sum_amounts(row.expense for row in new_rows),
        ending_register_balance=_latest_register_balance(report_expenses),
    )


def _in_period(expense: ExpenseRecord, period_start: date, period_end: date) -> bool:
    transaction_date = expense.transaction_date
    if transaction_date is None:
        return True
    return period_start <= transaction_date <= period_end


def _matches_bank_account(expense: ExpenseRecord, bank_account_name: str | None) -> bool:
    if not bank_account_name:
        return True
    if not expense.bank_account_name:
        return False
    return expense.bank_account_name.casefold() == bank_account_name.casefold()


def _is_reconciled_on_report(expense: ExpenseRecord, period_end: date) -> bool:
    if expense.reconciliation_status != "matched":
        return False

    posted_date = expense.bank_posted_date or expense.transaction_date
    if posted_date is None:
        return True
    return posted_date <= period_end


def _sum_amounts(expenses: list[ExpenseRecord]) -> Decimal:
    total = Decimal("0")
    for expense in expenses:
        if expense.total_amount is not None:
            total += expense.total_amount
    return total


def _latest_register_balance(expenses: list[ExpenseRecord]) -> Decimal | None:
    dated_balances = [
        (expense.transaction_date or date.min, expense.created_at, expense.balance_after_transaction)
        for expense in expenses
        if expense.balance_after_transaction is not None
    ]
    if not dated_balances:
        return None
    dated_balances.sort()
    return dated_balances[-1][2]
