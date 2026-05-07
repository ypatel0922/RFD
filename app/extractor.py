from __future__ import annotations

import base64
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.models import ExtractedReceiptData


SYSTEM_PROMPT = """You extract bookkeeping data from fire department receipts.
Return only valid JSON with these keys:
merchant_name, payee, transaction_date, total_amount, tax_amount, category,
payment_method, payment_reference, description, bank_account_name,
balance_after_transaction, confidence, notes.
Use ISO date format YYYY-MM-DD when a date is visible.
Use plain decimal numbers for money without currency symbols.
If a field is not visible, return null for that field.
Set confidence from 0 to 1 based on receipt legibility and certainty."""


class ReceiptExtractor:
    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def extract(
        self,
        *,
        receipt_bytes: bytes,
        content_type: str,
    ) -> ExtractedReceiptData:
        if not self.api_key:
            return ExtractedReceiptData(
                extraction_status="needs_review",
                confidence=0,
                notes=(
                    "Receipt stored successfully. Set OPENAI_API_KEY to enable "
                    "automatic extraction from uploaded receipt images."
                ),
            )

        return await run_in_threadpool(
            self._extract_with_openai,
            receipt_bytes,
            content_type,
        )

    def _extract_with_openai(
        self,
        receipt_bytes: bytes,
        content_type: str,
    ) -> ExtractedReceiptData:
        try:
            from openai import OpenAI
        except ImportError:
            return ExtractedReceiptData(
                extraction_status="failed",
                confidence=0,
                notes="The openai package is not installed, so extraction could not run.",
            )

        try:
            client = OpenAI(api_key=self.api_key)
            encoded_receipt = base64.b64encode(receipt_bytes).decode("ascii")
            data_url = f"data:{content_type};base64,{encoded_receipt}"
            response = client.chat.completions.create(
                model=self.model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Extract expense fields from this receipt image.",
                            },
                            {
                                "type": "image_url",
                                "image_url": {"url": data_url},
                            },
                        ],
                    },
                ],
            )
            raw_content = response.choices[0].message.content or "{}"
            payload = json.loads(raw_content)
            return self._normalize_payload(payload)
        except Exception as exc:  # noqa: BLE001 - preserve upload even if extraction fails.
            return ExtractedReceiptData(
                extraction_status="failed",
                confidence=0,
                notes=f"Automatic extraction failed: {exc}",
            )

    def _normalize_payload(self, payload: dict[str, Any]) -> ExtractedReceiptData:
        normalized = {
            "merchant_name": _blank_to_none(payload.get("merchant_name")),
            "payee": _blank_to_none(payload.get("payee")),
            "transaction_date": _blank_to_none(payload.get("transaction_date")),
            "total_amount": _decimal_or_none(payload.get("total_amount")),
            "tax_amount": _decimal_or_none(payload.get("tax_amount")),
            "category": _blank_to_none(payload.get("category")),
            "payment_method": _blank_to_none(payload.get("payment_method")),
            "payment_reference": _blank_to_none(payload.get("payment_reference")),
            "description": _blank_to_none(payload.get("description")),
            "bank_account_name": _blank_to_none(payload.get("bank_account_name")),
            "balance_after_transaction": _decimal_or_none(payload.get("balance_after_transaction")),
            "confidence": _confidence(payload.get("confidence")),
            "notes": _blank_to_none(payload.get("notes")),
        }
        has_required_bookkeeping_fields = bool(
            normalized["merchant_name"]
            and normalized["transaction_date"]
            and normalized["total_amount"] is not None
        )
        normalized["extraction_status"] = (
            "extracted" if has_required_bookkeeping_fields else "needs_review"
        )
        return ExtractedReceiptData.model_validate(normalized)


def _blank_to_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value).replace("$", "").replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None


def _confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(1, confidence))
