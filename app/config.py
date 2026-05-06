from functools import lru_cache
import os
from pathlib import Path

from pydantic import BaseModel, Field


class Settings(BaseModel):
    app_name: str = "RFD Expense Tracker"
    data_dir: Path
    receipt_dir: Path
    database_path: Path
    receipt_base_url: str = "/receipts"
    max_upload_bytes: int = Field(default=10 * 1024 * 1024)
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"


@lru_cache
def get_settings() -> Settings:
    data_dir = Path(os.getenv("RFD_DATA_DIR", "data")).resolve()
    receipt_dir = Path(os.getenv("RFD_RECEIPT_DIR", data_dir / "receipts")).resolve()
    database_path = Path(os.getenv("RFD_EXPENSE_DB", data_dir / "expenses.json")).resolve()

    return Settings(
        data_dir=data_dir,
        receipt_dir=receipt_dir,
        database_path=database_path,
        receipt_base_url=os.getenv("RFD_RECEIPT_BASE_URL", "/receipts"),
        max_upload_bytes=int(os.getenv("RFD_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024))),
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        openai_model=os.getenv("OPENAI_RECEIPT_MODEL", "gpt-4o-mini"),
    )
