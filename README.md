# RFD Expense Tracker

RFD is a first product slice for fire departments that need lightweight
bookkeeping around receipts and recurring weekly expenses.

This version includes:

- A web upload form for receipt images/PDFs.
- Durable local receipt storage under `data/receipts`.
- A JSON-backed expense log under `data/expenses.json`.
- Automatic receipt extraction through OpenAI Vision when `OPENAI_API_KEY` is
  configured.
- A safe manual-review fallback when extraction credentials are not configured.
- A receipt viewer endpoint so stored receipts remain linked to each expense.

## Run locally

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000.

## Configuration

Environment variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `RFD_DATA_DIR` | `data` | Root for local app data. |
| `RFD_RECEIPT_DIR` | `$RFD_DATA_DIR/receipts` | Local receipt storage root. |
| `RFD_EXPENSE_DB` | `$RFD_DATA_DIR/expenses.json` | JSON expense log path. |
| `RFD_MAX_UPLOAD_BYTES` | `10485760` | Maximum upload size. |
| `OPENAI_API_KEY` | unset | Enables receipt field extraction. |
| `OPENAI_RECEIPT_MODEL` | `gpt-4o-mini` | Vision-capable model for extraction. |

Without `OPENAI_API_KEY`, uploads still work and expenses are logged with
`needs_review` extraction status.

## Next production steps

The first slice intentionally keeps persistence local and simple. The storage
and repository code are isolated so the next steps can swap in:

1. S3/Azure/GCS object storage with retention policies for multi-year receipt
   access.
2. Postgres for audit-safe expense records, reconciliation records, funds, and
   fiscal periods.
3. Bank feed integration and transaction matching for reconciliation.
4. Report builders for quarterly/yearly summaries, NY 2% reports, and IRS 990
   support.
