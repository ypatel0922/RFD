from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import Settings, get_settings
from app.extractor import ReceiptExtractor
from app.models import ExpenseRecord
from app.repository import ExpenseRepository
from app.storage import LocalReceiptStorage


PROJECT_ROOT = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=PROJECT_ROOT / "templates")

app = FastAPI(title="RFD Expense Tracker")
app.mount("/static", StaticFiles(directory=PROJECT_ROOT / "static"), name="static")


def settings_dependency() -> Settings:
    return get_settings()


def repository_dependency(
    settings: Settings = Depends(settings_dependency),
) -> ExpenseRepository:
    return ExpenseRepository(settings.database_path)


def storage_dependency(
    settings: Settings = Depends(settings_dependency),
) -> LocalReceiptStorage:
    return LocalReceiptStorage(settings.receipt_dir, settings.receipt_base_url)


def extractor_dependency(
    settings: Settings = Depends(settings_dependency),
) -> ReceiptExtractor:
    return ReceiptExtractor(settings.openai_api_key, settings.openai_model)


@app.get("/", response_class=HTMLResponse)
def dashboard(
    request: Request,
    uploaded: str | None = None,
    settings: Settings = Depends(settings_dependency),
    repository: ExpenseRepository = Depends(repository_dependency),
) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "expenses": repository.list_expenses(limit=100),
            "uploaded": uploaded,
            "app_name": settings.app_name,
            "automatic_extraction_enabled": bool(settings.openai_api_key),
            "max_upload_mb": round(settings.max_upload_bytes / (1024 * 1024)),
        },
    )


@app.post("/receipts")
async def upload_receipt(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    repository: ExpenseRepository = Depends(repository_dependency),
    storage: LocalReceiptStorage = Depends(storage_dependency),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
) -> RedirectResponse:
    expense = await _store_and_log_receipt(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        repository=repository,
        storage=storage,
        extractor=extractor,
        settings=settings,
    )
    return RedirectResponse(url=f"/?uploaded={expense.id}", status_code=303)


@app.post("/api/receipts", response_model=ExpenseRecord)
async def upload_receipt_api(
    receipt: UploadFile = File(...),
    uploaded_by: str | None = Form(default=None),
    fund: str | None = Form(default=None),
    repository: ExpenseRepository = Depends(repository_dependency),
    storage: LocalReceiptStorage = Depends(storage_dependency),
    extractor: ReceiptExtractor = Depends(extractor_dependency),
    settings: Settings = Depends(settings_dependency),
) -> ExpenseRecord:
    return await _store_and_log_receipt(
        receipt=receipt,
        uploaded_by=uploaded_by,
        fund=fund,
        repository=repository,
        storage=storage,
        extractor=extractor,
        settings=settings,
    )


@app.get("/api/expenses", response_class=JSONResponse)
def list_expenses(
    repository: ExpenseRepository = Depends(repository_dependency),
) -> JSONResponse:
    expenses = [expense.model_dump(mode="json") for expense in repository.list_expenses(limit=100)]
    return JSONResponse({"expenses": expenses})


@app.get("/receipts/{receipt_id}")
def get_receipt(
    receipt_id: str,
    repository: ExpenseRepository = Depends(repository_dependency),
    storage: LocalReceiptStorage = Depends(storage_dependency),
) -> FileResponse:
    expense = repository.find_by_receipt_id(receipt_id)
    if expense is None:
        raise HTTPException(status_code=404, detail="Receipt not found")

    path = storage.path_for(expense.receipt_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Receipt file is missing")

    return FileResponse(
        path,
        media_type=expense.content_type,
        filename=expense.original_filename,
    )


async def _store_and_log_receipt(
    *,
    receipt: UploadFile,
    uploaded_by: str | None,
    fund: str | None,
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
    stored_receipt = storage.save(
        content=receipt_bytes,
        filename=receipt.filename,
        content_type=content_type,
    )
    extracted = await extractor.extract(
        receipt_bytes=receipt_bytes,
        content_type=content_type,
    )

    expense = ExpenseRecord(
        id=str(uuid4()),
        receipt_id=stored_receipt.id,
        receipt_url=stored_receipt.public_url,
        receipt_path=stored_receipt.relative_path,
        original_filename=receipt.filename or "receipt",
        content_type=content_type,
        created_at=datetime.now(UTC),
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
