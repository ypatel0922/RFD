from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

from app.config import Settings
from app.models import ExpenseRecord


class ExpenseRepository:
    """Small JSON-backed store for the first product slice.

    The repository boundary keeps the web layer independent from the storage
    mechanism so this can move to Postgres without changing route handlers.
    """

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def list_expenses(self, department_id: str, limit: int | None = 50) -> list[ExpenseRecord]:
        records = [
            expense
            for expense in self._read_all()
            if expense.department_id == department_id
        ]
        records.sort(key=lambda expense: expense.created_at, reverse=True)
        if limit is None:
            return records
        return records[:limit]

    def add(self, expense: ExpenseRecord) -> ExpenseRecord:
        records = self._read_all()
        records.append(expense)
        self._write_all(records)
        return expense

    def find_by_receipt_id(self, receipt_id: str, department_id: str) -> ExpenseRecord | None:
        for expense in self._read_all():
            if expense.receipt_id == receipt_id and expense.department_id == department_id:
                return expense
        return None

    def _read_all(self) -> list[ExpenseRecord]:
        if not self.database_path.exists():
            return []

        raw = self.database_path.read_text(encoding="utf-8").strip()
        if not raw:
            return []

        payload = json.loads(raw)
        return [ExpenseRecord.model_validate(item) for item in payload]

    def _write_all(self, records: list[ExpenseRecord]) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        payload = [record.model_dump(mode="json") for record in records]
        temp_path = self.database_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temp_path.replace(self.database_path)


class SupabaseExpenseRepository:
    """Supabase PostgREST-backed expense store.

    Requests use the signed-in user's access token so Supabase Row Level
    Security remains the source of truth for department isolation.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        access_token: str,
        default_department_name: str,
    ) -> None:
        if settings.supabase_url is None or settings.supabase_anon_key is None:
            raise ValueError("Supabase settings are required")
        self.supabase_url = settings.supabase_url
        self.supabase_anon_key = settings.supabase_anon_key
        self.access_token = access_token
        self.default_department_name = default_department_name

    def list_expenses(self, department_id: str, limit: int | None = 50) -> list[ExpenseRecord]:
        params = {
            "select": "*,departments(name)",
            "department_id": f"eq.{department_id}",
            "order": "created_at.desc",
        }
        if limit is not None:
            params["limit"] = str(limit)

        response = httpx.get(
            f"{self.supabase_url}/rest/v1/expenses",
            params=params,
            headers=self._headers(),
            timeout=10,
        )
        _raise_for_supabase_error(response)
        return [self._row_to_expense(row) for row in response.json()]

    def add(self, expense: ExpenseRecord) -> ExpenseRecord:
        payload = _expense_to_supabase_row(expense)
        response = httpx.post(
            f"{self.supabase_url}/rest/v1/expenses",
            params={"select": "*,departments(name)"},
            headers={
                **self._headers(),
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
            json=payload,
            timeout=10,
        )
        _raise_for_supabase_error(response)

        rows = response.json()
        if rows:
            return self._row_to_expense(rows[0])
        return expense

    def find_by_receipt_id(self, receipt_id: str, department_id: str) -> ExpenseRecord | None:
        response = httpx.get(
            f"{self.supabase_url}/rest/v1/expenses",
            params={
                "select": "*,departments(name)",
                "receipt_id": f"eq.{receipt_id}",
                "department_id": f"eq.{department_id}",
                "limit": "1",
            },
            headers=self._headers(),
            timeout=10,
        )
        _raise_for_supabase_error(response)

        rows = response.json()
        if not rows:
            return None
        return self._row_to_expense(rows[0])

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {self.access_token}",
        }

    def _row_to_expense(self, row: dict[str, Any]) -> ExpenseRecord:
        department_payload = row.get("departments") or {}
        department_name = department_payload.get("name") or self.default_department_name
        return ExpenseRecord(
            id=row["id"],
            department_id=row["department_id"],
            department_name=department_name,
            receipt_id=row["receipt_id"],
            receipt_url=f"/receipts/{row['receipt_id']}",
            receipt_path=row["receipt_path"],
            original_filename=row["original_filename"],
            content_type=row["content_type"],
            created_at=_datetime(row["created_at"]),
            created_by_user_id=row["created_by_user_id"],
            created_by_email=row["created_by_email"],
            uploaded_by=row.get("uploaded_by"),
            fund=row.get("fund"),
            payment_reference=row.get("payment_reference"),
            payee=row.get("payee"),
            description=row.get("description"),
            bank_account_name=row.get("bank_account_name"),
            merchant_name=row.get("merchant_name"),
            transaction_date=row.get("transaction_date"),
            total_amount=_decimal_or_none(row.get("total_amount")),
            tax_amount=_decimal_or_none(row.get("tax_amount")),
            balance_after_transaction=_decimal_or_none(row.get("balance_after_transaction")),
            category=row.get("category"),
            payment_method=row.get("payment_method"),
            extraction_status=row.get("extraction_status") or "needs_review",
            extraction_confidence=float(row.get("extraction_confidence") or 0),
            extraction_notes=row.get("extraction_notes"),
            reconciliation_status=row.get("reconciliation_status") or "pending_bank_match",
            bank_transaction_id=row.get("bank_transaction_id"),
            bank_posted_date=row.get("bank_posted_date"),
            bank_description=row.get("bank_description"),
            bank_amount=_decimal_or_none(row.get("bank_amount")),
            bank_match_confidence=float(row.get("bank_match_confidence") or 0),
            reconciled_at=_datetime_or_none(row.get("reconciled_at")),
        )


def _expense_to_supabase_row(expense: ExpenseRecord) -> dict[str, Any]:
    payload = expense.model_dump(mode="json")
    payload.pop("department_name", None)
    payload.pop("receipt_url", None)
    return payload


def _datetime(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _datetime_or_none(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    return _datetime(value)


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _raise_for_supabase_error(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        payload = response.json()
    except ValueError:
        payload = response.text
    raise RuntimeError(f"Supabase expense request failed: {payload}")
