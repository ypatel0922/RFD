from __future__ import annotations

import json
from pathlib import Path

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
