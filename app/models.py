from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator


ExtractionStatus = Literal["extracted", "needs_review", "failed"]
ReconciliationStatus = Literal["unreconciled", "matched", "needs_attention"]


class ExtractedReceiptData(BaseModel):
    merchant_name: str | None = None
    transaction_date: date | None = None
    total_amount: Decimal | None = None
    tax_amount: Decimal | None = None
    category: str | None = None
    payment_method: str | None = None
    extraction_status: ExtractionStatus = "needs_review"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    notes: str | None = None

    @field_validator("merchant_name", "category", "payment_method", "notes")
    @classmethod
    def blank_strings_to_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class StoredReceipt(BaseModel):
    id: str
    relative_path: str
    public_url: str
    original_filename: str
    content_type: str


class DepartmentContext(BaseModel):
    id: str
    name: str
    role: str = "member"


class AuthenticatedUser(BaseModel):
    id: str
    email: str
    access_token: str | None = None
    department: DepartmentContext


class ExpenseRecord(BaseModel):
    id: str
    department_id: str
    department_name: str
    receipt_id: str
    receipt_url: str
    receipt_path: str
    original_filename: str
    content_type: str
    created_at: datetime
    created_by_user_id: str
    created_by_email: str
    uploaded_by: str | None = None
    fund: str | None = None
    merchant_name: str | None = None
    transaction_date: date | None = None
    total_amount: Decimal | None = None
    tax_amount: Decimal | None = None
    category: str | None = None
    payment_method: str | None = None
    extraction_status: ExtractionStatus = "needs_review"
    extraction_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    extraction_notes: str | None = None
    reconciliation_status: ReconciliationStatus = "unreconciled"

    @field_validator(
        "department_id",
        "department_name",
        "created_by_user_id",
        "created_by_email",
        "uploaded_by",
        "fund",
        "merchant_name",
        "category",
        "payment_method",
        "extraction_notes",
    )
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None
