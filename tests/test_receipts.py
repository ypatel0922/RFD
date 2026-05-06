from datetime import UTC, datetime
from decimal import Decimal
from fastapi.testclient import TestClient
import httpx

from app.config import get_settings
from app.main import app, repository_for, storage_for
from app.models import AuthenticatedUser, DepartmentContext, ExpenseRecord
from app.repository import ExpenseRepository, SupabaseExpenseRepository
from app.storage import SupabaseReceiptStorage


def _configure_local_auth(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    get_settings.cache_clear()


def _login(client: TestClient, email: str = "treasurer@example.com") -> None:
    response = client.post(
        "/login",
        data={"email": email, "password": "password"},
        follow_redirects=False,
    )
    assert response.status_code == 303


def _expense(
    *,
    expense_id: str,
    receipt_id: str,
    department_id: str,
    department_name: str,
) -> ExpenseRecord:
    return ExpenseRecord(
        id=expense_id,
        department_id=department_id,
        department_name=department_name,
        receipt_id=receipt_id,
        receipt_url=f"/receipts/{receipt_id}",
        receipt_path=f"{department_id}/2026/05/{expense_id}/{receipt_id}.png",
        original_filename="receipt.png",
        content_type="image/png",
        created_at=datetime(2026, 5, 6, tzinfo=UTC),
        created_by_user_id="user-1",
        created_by_email="treasurer@example.com",
    )


def test_receipt_upload_requires_review_before_logging(tmp_path, monkeypatch):
    _configure_local_auth(tmp_path, monkeypatch)

    client = TestClient(app)
    _login(client)

    response = client.post(
        "/receipts/review",
        files={"receipt": ("fuel.png", b"\x89PNG\r\n\x1a\nreceipt-bytes", "image/png")},
        data={"uploaded_by": "Treasurer", "fund": "General Fund"},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "/receipts/review"

    settings = get_settings()
    repository = ExpenseRepository(settings.database_path)
    expenses = repository.list_expenses(settings.dev_department_id)
    assert expenses == []

    review_response = client.get("/receipts/review")
    assert review_response.status_code == 200
    assert "Review before logging" in review_response.text
    assert "General Fund" in review_response.text

    confirm_response = client.post(
        "/receipts/confirm",
        data={
            "uploaded_by": "Treasurer",
            "fund": "General Fund",
            "payment_reference": "Debit",
            "payee": "Fuel Stop",
            "description": "Fuel for apparatus",
            "bank_account_name": "Checking",
            "transaction_date": "2026-05-06",
            "total_amount": "42.17",
            "tax_amount": "1.23",
            "balance_after_transaction": "1050.25",
            "category": "Fuel",
            "payment_method": "Debit card",
        },
        follow_redirects=False,
    )

    assert confirm_response.status_code == 303
    expenses = repository.list_expenses(settings.dev_department_id)
    assert len(expenses) == 1
    expense = expenses[0]
    assert expense.department_id == settings.dev_department_id
    assert expense.department_name == settings.dev_department_name
    assert expense.created_by_email == "treasurer@example.com"
    assert expense.original_filename == "fuel.png"
    assert expense.uploaded_by == "Treasurer"
    assert expense.fund == "General Fund"
    assert expense.payment_reference == "Debit"
    assert expense.payee == "Fuel Stop"
    assert expense.description == "Fuel for apparatus"
    assert expense.bank_account_name == "Checking"
    assert expense.transaction_date.isoformat() == "2026-05-06"
    assert expense.total_amount == Decimal("42.17")
    assert expense.tax_amount == Decimal("1.23")
    assert expense.balance_after_transaction == Decimal("1050.25")
    assert expense.category == "Fuel"
    assert expense.payment_method == "Debit card"
    assert expense.extraction_status == "needs_review"
    assert expense.reconciliation_status == "pending_bank_match"
    assert expense.receipt_path.startswith(f"{settings.dev_department_id}/")
    assert f"/{expense.id}/" in expense.receipt_path
    assert (settings.receipt_dir / expense.receipt_path).exists()


def test_repository_round_trips_money_and_dates(tmp_path):
    repository = ExpenseRepository(tmp_path / "expenses.json")
    expense = _expense(
        expense_id="expense-1",
        receipt_id="receipt-1",
        department_id="department-1",
        department_name="Department 1",
    ).model_copy(
        update={
            "merchant_name": "Fuel Stop",
            "transaction_date": datetime(2026, 5, 5, tzinfo=UTC).date(),
            "total_amount": Decimal("42.17"),
            "tax_amount": Decimal("1.23"),
            "category": "Fuel",
            "extraction_status": "extracted",
            "extraction_confidence": 0.91,
        }
    )

    repository.add(expense)
    loaded = repository.list_expenses("department-1")[0]

    assert loaded.merchant_name == "Fuel Stop"
    assert loaded.total_amount == Decimal("42.17")
    assert loaded.transaction_date.isoformat() == "2026-05-05"


def test_repository_isolates_departments(tmp_path):
    repository = ExpenseRepository(tmp_path / "expenses.json")
    department_one_expense = _expense(
        expense_id="expense-1",
        receipt_id="receipt-1",
        department_id="department-1",
        department_name="Department 1",
    )
    department_two_expense = _expense(
        expense_id="expense-2",
        receipt_id="receipt-2",
        department_id="department-2",
        department_name="Department 2",
    )

    repository.add(department_one_expense)
    repository.add(department_two_expense)

    assert repository.list_expenses("department-1") == [department_one_expense]
    assert repository.find_by_receipt_id("receipt-2", "department-1") is None
    assert repository.find_by_receipt_id("receipt-2", "department-2") == department_two_expense


def test_expenses_api_returns_logged_expenses(tmp_path, monkeypatch):
    _configure_local_auth(tmp_path, monkeypatch)

    client = TestClient(app)
    _login(client)

    client.post(
        "/api/receipts",
        files={"receipt": ("meal.jpg", b"jpeg bytes", "image/jpeg")},
        data={"uploaded_by": "", "fund": ""},
    )

    response = client.get("/api/expenses")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["expenses"]) == 1
    assert payload["expenses"][0]["receipt_url"].startswith("/receipts/")
    assert payload["expenses"][0]["department_id"] == get_settings().dev_department_id
    assert payload["expenses"][0]["reconciliation_status"] == "pending_bank_match"


def test_dashboard_redirects_to_login_without_session(tmp_path, monkeypatch):
    _configure_local_auth(tmp_path, monkeypatch)

    client = TestClient(app)
    response = client.get("/", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/login"


def test_login_then_dashboard_renders_department_context(tmp_path, monkeypatch):
    _configure_local_auth(tmp_path, monkeypatch)

    client = TestClient(app)
    _login(client)
    response = client.get("/")

    assert response.status_code == 200
    assert "Receipt-first expense tracking" in response.text
    assert "Demo Fire Department" in response.text


def test_api_requires_login(tmp_path, monkeypatch):
    _configure_local_auth(tmp_path, monkeypatch)

    client = TestClient(app)
    response = client.get("/api/expenses")

    assert response.status_code == 401


def test_supabase_session_uses_supabase_adapters(tmp_path, monkeypatch):
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    get_settings.cache_clear()

    settings = get_settings()
    user = _supabase_user()

    assert isinstance(repository_for(settings, user), SupabaseExpenseRepository)
    assert isinstance(storage_for(settings, user), SupabaseReceiptStorage)


def test_supabase_repository_writes_and_maps_expenses(tmp_path, monkeypatch):
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    get_settings.cache_clear()

    requests: list[dict] = []

    def fake_post(url, *, params, headers, json, timeout):
        requests.append({
            "url": url,
            "params": params,
            "headers": headers,
            "json": json,
            "timeout": timeout,
        })
        return httpx.Response(201, json=[_supabase_expense_row()])

    monkeypatch.setattr("app.repository.httpx.post", fake_post)

    repository = SupabaseExpenseRepository(
        settings=get_settings(),
        access_token="access-token",
        default_department_name="Fallback Fire Department",
    )
    saved = repository.add(_supabase_expense())

    assert saved.department_name == "Lake Fire Department"
    assert saved.receipt_url == f"/receipts/{_SUPABASE_RECEIPT_ID}"
    assert saved.total_amount == Decimal("42.17")
    assert saved.payee == "Fuel Stop"
    assert saved.reconciliation_status == "pending_bank_match"
    assert requests[0]["url"] == "https://example.supabase.co/rest/v1/expenses"
    assert requests[0]["headers"]["Authorization"] == "Bearer access-token"
    assert requests[0]["json"]["department_id"] == _SUPABASE_DEPARTMENT_ID
    assert requests[0]["json"]["bank_account_name"] == "Checking"
    assert "department_name" not in requests[0]["json"]
    assert "receipt_url" not in requests[0]["json"]


def test_supabase_storage_uploads_and_reads_private_receipts(tmp_path, monkeypatch):
    monkeypatch.setenv("RFD_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    get_settings.cache_clear()

    calls: list[dict] = []

    def fake_post(url, *, headers, content, timeout):
        calls.append({
            "method": "POST",
            "url": url,
            "headers": headers,
            "content": content,
            "timeout": timeout,
        })
        return httpx.Response(200, json={"Key": "receipts/path"})

    def fake_get(url, *, headers, timeout):
        calls.append({
            "method": "GET",
            "url": url,
            "headers": headers,
            "timeout": timeout,
        })
        return httpx.Response(200, content=b"receipt-bytes")

    monkeypatch.setattr("app.storage.httpx.post", fake_post)
    monkeypatch.setattr("app.storage.httpx.get", fake_get)

    storage = SupabaseReceiptStorage(
        settings=get_settings(),
        access_token="access-token",
        public_url_base="/receipts",
    )
    stored = storage.save(
        content=b"receipt-bytes",
        filename="receipt.png",
        content_type="image/png",
        department_id=_SUPABASE_DEPARTMENT_ID,
        expense_id=_SUPABASE_EXPENSE_ID,
    )
    downloaded = storage.read(stored.relative_path)

    assert downloaded == b"receipt-bytes"
    assert stored.relative_path.startswith(f"{_SUPABASE_DEPARTMENT_ID}/")
    assert f"/{_SUPABASE_EXPENSE_ID}/" in stored.relative_path
    assert calls[0]["method"] == "POST"
    assert "/storage/v1/object/receipts/" in calls[0]["url"]
    assert calls[0]["headers"]["Authorization"] == "Bearer access-token"
    assert calls[0]["headers"]["Content-Type"] == "image/png"
    assert calls[1]["method"] == "GET"
    assert "/storage/v1/object/authenticated/receipts/" in calls[1]["url"]


_SUPABASE_DEPARTMENT_ID = "0a765b90-5c2a-42d7-829e-1f53ae44dc87"
_SUPABASE_EXPENSE_ID = "11111111-1111-4111-8111-111111111111"
_SUPABASE_RECEIPT_ID = "22222222-2222-4222-8222-222222222222"


def _supabase_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        id="33333333-3333-4333-8333-333333333333",
        email="treasurer@lakefd.test",
        access_token="access-token",
        department=DepartmentContext(
            id=_SUPABASE_DEPARTMENT_ID,
            name="Lake Fire Department",
            role="treasurer",
        ),
    )


def _supabase_expense() -> ExpenseRecord:
    return ExpenseRecord(
        id=_SUPABASE_EXPENSE_ID,
        department_id=_SUPABASE_DEPARTMENT_ID,
        department_name="Lake Fire Department",
        receipt_id=_SUPABASE_RECEIPT_ID,
        receipt_url=f"/receipts/{_SUPABASE_RECEIPT_ID}",
        receipt_path=(
            f"{_SUPABASE_DEPARTMENT_ID}/2026/05/"
            f"{_SUPABASE_EXPENSE_ID}/{_SUPABASE_RECEIPT_ID}.png"
        ),
        original_filename="receipt.png",
        content_type="image/png",
        created_at=datetime(2026, 5, 6, tzinfo=UTC),
        created_by_user_id="33333333-3333-4333-8333-333333333333",
        created_by_email="treasurer@lakefd.test",
        payment_reference="Debit",
        payee="Fuel Stop",
        description="Fuel for apparatus",
        bank_account_name="Checking",
        merchant_name="Fuel Stop",
        transaction_date=datetime(2026, 5, 5, tzinfo=UTC).date(),
        total_amount=Decimal("42.17"),
        tax_amount=Decimal("1.23"),
        balance_after_transaction=Decimal("1050.25"),
        category="Fuel",
        payment_method="Debit card",
        extraction_status="extracted",
        extraction_confidence=0.91,
        reconciliation_status="pending_bank_match",
    )


def _supabase_expense_row() -> dict:
    row = _supabase_expense().model_dump(mode="json")
    row.pop("department_name")
    row.pop("receipt_url")
    row["departments"] = {"name": "Lake Fire Department"}
    return row
