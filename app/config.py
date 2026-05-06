from functools import lru_cache
import os
from pathlib import Path

from pydantic import BaseModel, Field


ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseModel):
    app_name: str = "RFD Expense Tracker"
    data_dir: Path
    receipt_dir: Path
    database_path: Path
    receipt_base_url: str = "/receipts"
    max_upload_bytes: int = Field(default=10 * 1024 * 1024)
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    session_secret: str
    supabase_url: str | None = None
    supabase_anon_key: str | None = None
    supabase_receipts_bucket: str = "receipts"
    dev_auth_enabled: bool = True
    dev_department_id: str = "demo-fire-department"
    dev_department_name: str = "Demo Fire Department"

    @property
    def supabase_auth_enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)


@lru_cache
def get_settings() -> Settings:
    if _env_bool("RFD_LOAD_DOTENV", default=True):
        _load_dotenv(ENV_FILE)

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
        session_secret=os.getenv("RFD_SESSION_SECRET", "dev-insecure-change-me"),
        supabase_url=_strip_trailing_slash(os.getenv("SUPABASE_URL")),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY"),
        supabase_receipts_bucket=os.getenv("SUPABASE_RECEIPTS_BUCKET", "receipts"),
        dev_auth_enabled=_env_bool("RFD_DEV_AUTH_ENABLED", default=True),
        dev_department_id=os.getenv("RFD_DEV_DEPARTMENT_ID", "demo-fire-department"),
        dev_department_name=os.getenv("RFD_DEV_DEPARTMENT_NAME", "Demo Fire Department"),
    )


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", maxsplit=1)
        key = key.strip()
        if not key or key in os.environ:
            continue

        os.environ[key] = _unquote_env_value(value.strip())


def _unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _strip_trailing_slash(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().rstrip("/")
    return value or None


def _env_bool(name: str, *, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
