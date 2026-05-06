# RFD Expense Tracker

RFD is a first product slice for fire departments that need lightweight
bookkeeping around receipts and recurring weekly expenses.

This version includes:

- A login screen backed by Supabase Auth when Supabase credentials are
  configured.
- Department membership scoping so each user only sees one department
  dashboard and ledger.
- A web upload form for receipt images/PDFs.
- Department/expense-scoped receipt storage paths under `data/receipts`.
- A department-scoped JSON expense log under `data/expenses.json`.
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

If `SUPABASE_URL` and `SUPABASE_ANON_KEY` are not configured, the app runs in
local development auth mode. Any non-empty email/password can sign in to the
configured demo department so the full department-scoped flow remains testable.

## Configuration

Environment variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `RFD_DATA_DIR` | `data` | Root for local app data. |
| `RFD_RECEIPT_DIR` | `$RFD_DATA_DIR/receipts` | Local receipt storage root. |
| `RFD_EXPENSE_DB` | `$RFD_DATA_DIR/expenses.json` | JSON expense log path. |
| `RFD_MAX_UPLOAD_BYTES` | `10485760` | Maximum upload size. |
| `RFD_SESSION_SECRET` | `dev-insecure-change-me` | Secret used to sign login session cookies. Set a strong value outside local development. |
| `SUPABASE_URL` | unset | Enables Supabase Auth when paired with `SUPABASE_ANON_KEY`. |
| `SUPABASE_ANON_KEY` | unset | Public anon key used for Supabase Auth and department membership lookups. |
| `RFD_DEV_AUTH_ENABLED` | `true` | Allows local development login when Supabase is not configured. |
| `RFD_DEV_DEPARTMENT_ID` | `demo-fire-department` | Local development department id. |
| `RFD_DEV_DEPARTMENT_NAME` | `Demo Fire Department` | Local development department name. |
| `OPENAI_API_KEY` | unset | Enables receipt field extraction. |
| `OPENAI_RECEIPT_MODEL` | `gpt-4o-mini` | Vision-capable model for extraction. |

Without `OPENAI_API_KEY`, uploads still work and expenses are logged with
`needs_review` extraction status.

## Supabase setup

Run the migration in `supabase/migrations/001_department_expense_isolation.sql`
against your Supabase project. It creates:

- `departments`
- `department_members`
- `expenses`
- A private `receipts` storage bucket
- Row Level Security policies that only allow authenticated users to access
  departments, members, expenses, and receipt objects for departments they
  belong to

Receipt object paths are designed as:

```text
<department_id>/<year>/<month>/<expense_id>/<receipt_id>.<extension>
```

That keeps every stored receipt tied to both a department and an individual
expense line item.

## Next production steps

The first slice keeps runtime expense persistence local while adding the
Supabase auth and RLS foundation. The storage and repository code are isolated
so the next steps can swap in:

1. Supabase Postgres writes for audit-safe expense records, reconciliation
   records, funds, and fiscal periods.
2. Supabase Storage uploads/downloads using the private `receipts` bucket and
   the same department/expense path structure.
3. Bank feed integration and transaction matching for reconciliation.
4. Report builders for quarterly/yearly summaries, NY 2% reports, and IRS 990
   support.
