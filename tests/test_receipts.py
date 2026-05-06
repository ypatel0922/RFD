from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models import ExpenseRecord
from app.repository import ExpenseRepository


def test_receipt_upload_stores_file_and_logs_expense(tmp_path, monkeypatch):
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    get_settings.cache_clear()

    client = TestClient(app)
    response = client.post(
        "/receipts",
        files={"receipt": ("fuel.png", b"\x89PNG\r\n\x1a\nreceipt-bytes", "image/png")},
        data={"uploaded_by": "Treasurer", "fund": "General Fund"},
        follow_redirects=False,
    )

    assert response.status_code == 303

    settings = get_settings()
    repository = ExpenseRepository(settings.database_path)
    expenses = repository.list_expenses()

    assert len(expenses) == 1
    expense = expenses[0]
    assert expense.original_filename == "fuel.png"
    assert expense.uploaded_by == "Treasurer"
    assert expense.fund == "General Fund"
    assert expense.extraction_status == "needs_review"
    assert expense.reconciliation_status == "unreconciled"
    assert (settings.receipt_dir / expense.receipt_path).exists()


def test_repository_round_trips_money_and_dates(tmp_path):
    repository = ExpenseRepository(tmp_path / "expenses.json")
    expense = ExpenseRecord(
        id="expense-1",
        receipt_id="receipt-1",
        receipt_url="/receipts/receipt-1",
        receipt_path="2026/05/receipt-1.png",
        original_filename="receipt.png",
        content_type="image/png",
        created_at=datetime(2026, 5, 6, tzinfo=UTC),
        merchant_name="Fuel Stop",
        transaction_date=datetime(2026, 5, 5, tzinfo=UTC).date(),
        total_amount=Decimal("42.17"),
        tax_amount=Decimal("1.23"),
        category="Fuel",
        extraction_status="extracted",
        extraction_confidence=0.91,
    )

    repository.add(expense)
    loaded = repository.list_expenses()[0]

    assert loaded.merchant_name == "Fuel Stop"
    assert loaded.total_amount == Decimal("42.17")
    assert loaded.transaction_date.isoformat() == "2026-05-05"


def test_expenses_api_returns_logged_expenses(tmp_path, monkeypatch):
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    get_settings.cache_clear()

    client = TestClient(app)
    client.post(
        "/receipts",
        files={"receipt": ("meal.jpg", b"jpeg bytes", "image/jpeg")},
        data={"uploaded_by": "", "fund": ""},
    )

    response = client.get("/api/expenses")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["expenses"]) == 1
    assert payload["expenses"][0]["receipt_url"].startswith("/receipts/")
