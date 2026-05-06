from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import AuthError, AuthService
from app.config import Settings, get_settings
from app.extractor import ReceiptExtractor
from app.models import AuthenticatedUser, ExpenseDraft, ExpenseRecord
from app.repository import ExpenseRepository, SupabaseExpenseRepository
from app.session import SessionManager
from app.storage import LocalReceiptStorage, SupabaseReceiptStorage


PROJECT_ROOT = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=PROJECT_ROOT / "templates")

app = FastAPI(title="RFD Expense Tracker")
app.mount("/static", StaticFiles(directory=PROJECT_ROOT / "static"), name="static")


def settings_dependency() -> Settings:
    return get_settings()


def extractor_dependency(
    settings: Settings = Depends(settings_dependency),
) -> ReceiptExtractor:
    return ReceiptExtractor(settings.openai_api_key, settings.openai_model)


def auth_dependency(
    settings: Settings = Depends(settings_dependency),
) -> AuthService:
    return AuthService(settings)


def session_dependency(
    settings: Settings = Depends(settings_dependency),
) -> SessionManager:
    return SessionManager(settings)


def optional_user_dependency(
    request: Request,
    session: SessionManager = Depends(session_dependency),
) -> AuthenticatedUser | None:
    return session.load_user(request)


def require_user_dependency(
    request: Request,
    session: SessionManager = Depends(session_dependency),
) -> AuthenticatedUser:
    user = session.load_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Log in to access this department.")
    return user


@app.get("/login", response_class=HTMLResponse)
def login_page(
    request: Request,
    error: str | None = None,
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
) -> Response:
    if current_user is not None:
        return RedirectResponse(url="/", status_code=303)

    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={
            "app_name": settings.app_name,
            "error": error,
            "supabase_auth_enabled": settings.supabase_auth_enabled,
            "dev_auth_enabled": settings.dev_auth_enabled,
        },
    )


@app.post("/login")
def login(
    email: str = Form(...),
    password: str = Form(...),
    auth: AuthService = Depends(auth_dependency),
    session: SessionManager = Depends(session_dependency),
) -> RedirectResponse:
    try:
        user = auth.login(email=email, password=password)
    except AuthError as exc:
        return RedirectResponse(url=f"/login?error={quote(str(exc))}", status_code=303)

    response = RedirectResponse(url="/", status_code=303)
    session.sign_in(response, user)
    return response


@app.post("/logout")
def logout(
    session: SessionManager = Depends(session_dependency),
) -> RedirectResponse:
    response = RedirectResponse(url="/login", status_code=303)
    session.sign_out(response)
    return response


@app.get("/", response_class=HTMLResponse)
def dashboard(
    request: Request,
    uploaded: str | None = None,
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
) -> Response:
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

    repository = repository_for(settings, current_user)
    context = {
        "expenses": repository.list_expenses(current_user.department.id, limit=100),
        "uploaded": uploaded,
        "app_name": settings.app_name,
        "current_user": current_user,
        "department": current_user.department,
        "persistence_mode": "Supabase" if current_user.access_token else "Local development",
        "automatic_extraction_enabled": bool(settings.openai_api_key),
        "max_upload_mb": round(settings.max_upload_bytes / (1024 * 1024)),
    }
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context=context,
    )


@app.post("/receipts")
async def upload_receipt_legacy(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
    session: SessionManager = Depends(session_dependency),
) -> RedirectResponse:
    return await prepare_receipt_review(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        extractor=extractor,
        settings=settings,
        current_user=current_user,
        session=session,
    )


@app.post("/receipts/review")
async def prepare_receipt_review(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
    session: SessionManager = Depends(session_dependency),
) -> RedirectResponse:
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

    draft = await _store_receipt_draft(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        current_user=current_user,
        storage=storage_for(settings, current_user),
        extractor=extractor,
        settings=settings,
    )
    response = RedirectResponse(url="/receipts/review", status_code=303)
    session.save_expense_draft(response, draft)
    return response


@app.get("/receipts/review", response_class=HTMLResponse)
def review_receipt(
    request: Request,
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
    session: SessionManager = Depends(session_dependency),
) -> Response:
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

    draft = session.load_expense_draft(request)
    if draft is None or not _draft_belongs_to_user(draft, current_user):
        return RedirectResponse(url="/", status_code=303)

    return templates.TemplateResponse(
        request=request,
        name="review_expense.html",
        context={
            "app_name": settings.app_name,
            "current_user": current_user,
            "department": current_user.department,
            "draft": draft,
        },
    )


@app.post("/receipts/confirm")
def confirm_receipt(
    request: Request,
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    payment_reference: str | None = Form(default=None),
    payee: str | None = Form(default=None),
    description: str | None = Form(default=None),
    bank_account_name: str | None = Form(default=None),
    transaction_date: str | None = Form(default=None),
    total_amount: str | None = Form(default=None),
    tax_amount: str | None = Form(default=None),
    balance_after_transaction: str | None = Form(default=None),
    category: str | None = Form(default=None),
    payment_method: str | None = Form(default=None),
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
    session: SessionManager = Depends(session_dependency),
) -> RedirectResponse:
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

    draft = session.load_expense_draft(request)
    if draft is None or not _draft_belongs_to_user(draft, current_user):
        return RedirectResponse(url="/", status_code=303)

    expense = _expense_from_review(
        draft=draft,
        uploaded_by=uploaded_by,
        fund=fund,
        payment_reference=payment_reference,
        payee=payee,
        description=description,
        bank_account_name=bank_account_name,
        transaction_date=transaction_date,
        total_amount=total_amount,
        tax_amount=tax_amount,
        balance_after_transaction=balance_after_transaction,
        category=category,
        payment_method=payment_method,
    )
    try:
        repository_for(settings, current_user).add(expense)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    response = RedirectResponse(url=f"/?uploaded={expense.id}", status_code=303)
    session.clear_expense_draft(response)
    return response


@app.post("/api/receipts", response_model=ExpenseRecord)
async def upload_receipt_api(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser = Depends(require_user_dependency),
) -> ExpenseRecord:
    return await _store_and_log_receipt(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        current_user=current_user,
        repository=repository_for(settings, current_user),
        storage=storage_for(settings, current_user),
        extractor=extractor,
        settings=settings,
    )


@app.get("/api/expenses", response_class=JSONResponse)
def list_expenses(
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser = Depends(require_user_dependency),
) -> JSONResponse:
    repository = repository_for(settings, current_user)
    expenses = [
        expense.model_dump(mode="json")
        for expense in repository.list_expenses(current_user.department.id, limit=100)
    ]
    return JSONResponse({"expenses": expenses})


@app.get("/receipts/{receipt_id}")
def get_receipt(
    receipt_id: str,
    request: Request,
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser = Depends(require_user_dependency),
    session: SessionManager = Depends(session_dependency),
) -> Response:
    repository = repository_for(settings, current_user)
    storage = storage_for(settings, current_user)
    expense = repository.find_by_receipt_id(receipt_id, current_user.department.id)
    draft = session.load_expense_draft(request)
    receipt_source = expense
    if receipt_source is None and draft is not None and _draft_belongs_to_user(draft, current_user):
        if draft.receipt_id == receipt_id:
            receipt_source = draft
    if receipt_source is None:
        raise HTTPException(status_code=404, detail="Receipt not found")

    try:
        content = storage.read(receipt_source.receipt_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Receipt file is missing")
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    filename = receipt_source.original_filename.replace('"', "")
    return Response(
        content=content,
        media_type=receipt_source.content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


async def _store_and_log_receipt(
    *,
    receipt: UploadFile,
    uploaded_by: str | None,
    fund: str | None,
    current_user: AuthenticatedUser,
    repository: ExpenseRepository,
    storage: LocalReceiptStorage,
    extractor: ReceiptExtractor,
    settings: Settings,
) -> ExpenseRecord:
    _validate_upload(receipt)
    receipt_bytes = await receipt.read()
    if not receipt_bytes:
        raise HTTPException(status_code=400, detail="Uploaded receipt is empty")
    if len(receipt_bytes) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Receipt exceeds the {settings.max_upload_bytes} byte upload limit",
        )

    content_type = receipt.content_type or "application/octet-stream"
    expense_id = str(uuid4())
    stored_receipt = storage.save(
        content=receipt_bytes,
        filename=receipt.filename,
        content_type=content_type,
        department_id=current_user.department.id,
        expense_id=expense_id,
    )
    extracted = await extractor.extract(
        receipt_bytes=receipt_bytes,
        content_type=content_type,
    )

    expense = ExpenseRecord(
        id=expense_id,
        department_id=current_user.department.id,
        department_name=current_user.department.name,
        receipt_id=stored_receipt.id,
        receipt_url=stored_receipt.public_url,
        receipt_path=stored_receipt.relative_path,
        original_filename=receipt.filename or "receipt",
        content_type=content_type,
        created_at=datetime.now(UTC),
        created_by_user_id=current_user.id,
        created_by_email=current_user.email,
        uploaded_by=uploaded_by,
        fund=fund,
        payment_reference=extracted.payment_reference,
        payee=extracted.payee or extracted.merchant_name,
        description=extracted.description,
        bank_account_name=extracted.bank_account_name,
        merchant_name=extracted.merchant_name,
        transaction_date=extracted.transaction_date,
        total_amount=extracted.total_amount,
        tax_amount=extracted.tax_amount,
        balance_after_transaction=extracted.balance_after_transaction,
        category=extracted.category,
        payment_method=extracted.payment_method,
        extraction_status=extracted.extraction_status,
        extraction_confidence=extracted.confidence,
        extraction_notes=extracted.notes,
    )
    return repository.add(expense)


async def _store_receipt_draft(
    *,
    receipt: UploadFile,
    uploaded_by: str | None,
    fund: str | None,
    current_user: AuthenticatedUser,
    storage: LocalReceiptStorage | SupabaseReceiptStorage,
    extractor: ReceiptExtractor,
    settings: Settings,
) -> ExpenseDraft:
    _validate_upload(receipt)
    receipt_bytes = await receipt.read()
    if not receipt_bytes:
        raise HTTPException(status_code=400, detail="Uploaded receipt is empty")
    if len(receipt_bytes) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Receipt exceeds the {settings.max_upload_bytes} byte upload limit",
        )

    content_type = receipt.content_type or "application/octet-stream"
    expense_id = str(uuid4())
    stored_receipt = storage.save(
        content=receipt_bytes,
        filename=receipt.filename,
        content_type=content_type,
        department_id=current_user.department.id,
        expense_id=expense_id,
    )
    extracted = await extractor.extract(
        receipt_bytes=receipt_bytes,
        content_type=content_type,
    )

    return ExpenseDraft(
        id=expense_id,
        department_id=current_user.department.id,
        department_name=current_user.department.name,
        receipt_id=stored_receipt.id,
        receipt_url=stored_receipt.public_url,
        receipt_path=stored_receipt.relative_path,
        original_filename=receipt.filename or "receipt",
        content_type=content_type,
        created_at=datetime.now(UTC),
        created_by_user_id=current_user.id,
        created_by_email=current_user.email,
        uploaded_by=uploaded_by,
        fund=fund,
        payment_reference=extracted.payment_reference,
        payee=extracted.payee or extracted.merchant_name,
        description=extracted.description,
        bank_account_name=extracted.bank_account_name,
        merchant_name=extracted.merchant_name,
        transaction_date=extracted.transaction_date,
        total_amount=extracted.total_amount,
        tax_amount=extracted.tax_amount,
        balance_after_transaction=extracted.balance_after_transaction,
        category=extracted.category,
        payment_method=extracted.payment_method,
        extraction_status=extracted.extraction_status,
        extraction_confidence=extracted.confidence,
        extraction_notes=extracted.notes,
    )


def _expense_from_review(
    *,
    draft: ExpenseDraft,
    uploaded_by: str | None,
    fund: str | None,
    payment_reference: str | None,
    payee: str | None,
    description: str | None,
    bank_account_name: str | None,
    transaction_date: str | None,
    total_amount: str | None,
    tax_amount: str | None,
    balance_after_transaction: str | None,
    category: str | None,
    payment_method: str | None,
) -> ExpenseRecord:
    confirmed_payee = _optional_text(payee) or draft.payee or draft.merchant_name
    return ExpenseRecord(
        id=draft.id,
        department_id=draft.department_id,
        department_name=draft.department_name,
        receipt_id=draft.receipt_id,
        receipt_url=draft.receipt_url,
        receipt_path=draft.receipt_path,
        original_filename=draft.original_filename,
        content_type=draft.content_type,
        created_at=draft.created_at,
        created_by_user_id=draft.created_by_user_id,
        created_by_email=draft.created_by_email,
        uploaded_by=_optional_text(uploaded_by),
        fund=_optional_text(fund),
        payment_reference=_optional_text(payment_reference),
        payee=confirmed_payee,
        description=_optional_text(description),
        bank_account_name=_optional_text(bank_account_name),
        merchant_name=confirmed_payee,
        transaction_date=_date_or_none(transaction_date),
        total_amount=_decimal_or_none(total_amount),
        tax_amount=_decimal_or_none(tax_amount),
        balance_after_transaction=_decimal_or_none(balance_after_transaction),
        category=_optional_text(category),
        payment_method=_optional_text(payment_method),
        extraction_status=draft.extraction_status,
        extraction_confidence=draft.extraction_confidence,
        extraction_notes=draft.extraction_notes,
        reconciliation_status="pending_bank_match",
    )


def _draft_belongs_to_user(draft: ExpenseDraft, current_user: AuthenticatedUser) -> bool:
    return (
        draft.department_id == current_user.department.id
        and draft.created_by_user_id == current_user.id
    )


def _optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _date_or_none(value: str | None) -> date | None:
    value = _optional_text(value)
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {value}") from exc


def _decimal_or_none(value: str | None) -> Decimal | None:
    value = _optional_text(value)
    if value is None:
        return None
    normalized = value.replace("$", "").replace(",", "")
    try:
        return Decimal(normalized)
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {value}") from exc


def _validate_upload(receipt: UploadFile) -> None:
    content_type = receipt.content_type or ""
    allowed_content_types = {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "application/pdf",
    }
    if content_type in allowed_content_types:
        return
    raise HTTPException(
        status_code=400,
        detail="Upload a JPG, PNG, WebP, GIF, or PDF receipt.",
    )


def repository_for(
    settings: Settings,
    current_user: AuthenticatedUser,
) -> ExpenseRepository | SupabaseExpenseRepository:
    if settings.supabase_auth_enabled and current_user.access_token:
        return SupabaseExpenseRepository(
            settings=settings,
            access_token=current_user.access_token,
            default_department_name=current_user.department.name,
        )
    return ExpenseRepository(settings.database_path)


def storage_for(
    settings: Settings,
    current_user: AuthenticatedUser,
) -> LocalReceiptStorage | SupabaseReceiptStorage:
    if settings.supabase_auth_enabled and current_user.access_token:
        return SupabaseReceiptStorage(
            settings=settings,
            access_token=current_user.access_token,
            public_url_base=settings.receipt_base_url,
        )
    return LocalReceiptStorage(settings.receipt_dir, settings.receipt_base_url)
