from __future__ import annotations

from datetime import UTC, datetime
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
from app.models import AuthenticatedUser, ExpenseRecord
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
async def upload_receipt(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser | None = Depends(optional_user_dependency),
) -> RedirectResponse:
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

    expense = await _store_and_log_receipt(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        current_user=current_user,
        repository=repository_for(settings, current_user),
        storage=storage_for(settings, current_user),
        extractor=extractor,
        settings=settings,
    )
    return RedirectResponse(url=f"/?uploaded={expense.id}", status_code=303)


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
    settings: Settings = Depends(settings_dependency),
    current_user: AuthenticatedUser = Depends(require_user_dependency),
) -> Response:
    repository = repository_for(settings, current_user)
    storage = storage_for(settings, current_user)
    expense = repository.find_by_receipt_id(receipt_id, current_user.department.id)
    if expense is None:
        raise HTTPException(status_code=404, detail="Receipt not found")

    try:
        content = storage.read(expense.receipt_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Receipt file is missing")
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    filename = expense.original_filename.replace('"', "")
    return Response(
        content=content,
        media_type=expense.content_type,
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
        merchant_name=extracted.merchant_name,
        transaction_date=extracted.transaction_date,
        total_amount=extracted.total_amount,
        tax_amount=extracted.tax_amount,
        category=extracted.category,
        payment_method=extracted.payment_method,
        extraction_status=extracted.extraction_status,
        extraction_confidence=extracted.confidence,
        extraction_notes=extracted.notes,
    )
    return repository.add(expense)


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
