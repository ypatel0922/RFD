from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import httpx
from pydantic import BaseModel

from app.config import Settings


MIME_TYPE_SUFFIXES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
}


class StoredReceipt(BaseModel):
    id: str
    relative_path: str
    public_url: str


class LocalReceiptStorage:
    """Development storage adapter.

    This keeps the app runnable without cloud credentials while isolating the
    storage boundary so S3/Azure/GCS can replace it later.
    """

    def __init__(self, root: Path, public_url_base: str) -> None:
        self.root = root
        self.public_url_base = public_url_base.rstrip("/")

    def save(
        self,
        *,
        content: bytes,
        filename: str | None,
        content_type: str | None,
        department_id: str,
        expense_id: str,
    ) -> StoredReceipt:
        receipt_id = str(uuid4())
        suffix = self._suffix_for(filename, content_type)
        now = datetime.now(UTC)
        relative_path = (
            Path(_safe_path_segment(department_id))
            / str(now.year)
            / f"{now.month:02d}"
            / _safe_path_segment(expense_id)
            / f"{receipt_id}{suffix}"
        )
        target = (self.root / relative_path).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

        return StoredReceipt(
            id=receipt_id,
            relative_path=relative_path.as_posix(),
            public_url=f"{self.public_url_base}/{receipt_id}",
        )

    def path_for(self, relative_path: str) -> Path:
        root = self.root.resolve()
        path = (root / relative_path).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Receipt path escapes the configured storage root")
        return path

    def read(self, relative_path: str) -> bytes:
        return self.path_for(relative_path).read_bytes()

    @staticmethod
    def _suffix_for(filename: str | None, content_type: str | None) -> str:
        if content_type in MIME_TYPE_SUFFIXES:
            return MIME_TYPE_SUFFIXES[content_type]

        if filename:
            suffix = Path(filename).suffix.lower()
            if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"}:
                return ".jpg" if suffix == ".jpeg" else suffix

        return ".bin"


class SupabaseReceiptStorage:
    """Supabase private bucket-backed receipt storage."""

    def __init__(
        self,
        *,
        settings: Settings,
        access_token: str,
        public_url_base: str,
    ) -> None:
        if settings.supabase_url is None or settings.supabase_anon_key is None:
            raise ValueError("Supabase settings are required")
        self.supabase_url = settings.supabase_url
        self.supabase_anon_key = settings.supabase_anon_key
        self.access_token = access_token
        self.bucket = settings.supabase_receipts_bucket
        self.public_url_base = public_url_base.rstrip("/")

    def save(
        self,
        *,
        content: bytes,
        filename: str | None,
        content_type: str | None,
        department_id: str,
        expense_id: str,
    ) -> StoredReceipt:
        receipt_id = str(uuid4())
        suffix = LocalReceiptStorage._suffix_for(filename, content_type)
        now = datetime.now(UTC)
        relative_path = (
            Path(_safe_path_segment(department_id))
            / str(now.year)
            / f"{now.month:02d}"
            / _safe_path_segment(expense_id)
            / f"{receipt_id}{suffix}"
        ).as_posix()

        response = httpx.post(
            f"{self.supabase_url}/storage/v1/object/{self.bucket}/{quote(relative_path, safe='/')}",
            headers={
                **self._headers(),
                "Content-Type": content_type or "application/octet-stream",
                "x-upsert": "false",
            },
            content=content,
            timeout=30,
        )
        _raise_for_supabase_error(response)

        return StoredReceipt(
            id=receipt_id,
            relative_path=relative_path,
            public_url=f"{self.public_url_base}/{receipt_id}",
        )

    def read(self, relative_path: str) -> bytes:
        response = httpx.get(
            f"{self.supabase_url}/storage/v1/object/authenticated/{self.bucket}/{quote(relative_path, safe='/')}",
            headers=self._headers(),
            timeout=30,
        )
        _raise_for_supabase_error(response)
        return response.content

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {self.access_token}",
        }


def _safe_path_segment(value: str) -> str:
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in value)


def _raise_for_supabase_error(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        payload = response.json()
    except ValueError:
        payload = response.text
    raise RuntimeError(f"Supabase storage request failed: {payload}")
