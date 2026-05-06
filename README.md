# RFD Expense Tracker

RFD is a first product slice for fire departments that need lightweight
bookkeeping around receipts and recurring weekly expenses.

This version includes:

- A login screen backed by Supabase Auth when Supabase credentials are
  configured.
- A self-service account creation screen with department autocomplete and role
  selection.
- Department membership scoping so each user only sees one department
  dashboard and ledger.
- A two-step capture flow: upload a receipt or take a mobile photo, then review
  autofilled register fields before logging the expense.
- Supabase Postgres expense persistence when signed in with Supabase Auth.
- Supabase Storage uploads/downloads using a private department-scoped
  `receipts` bucket when signed in with Supabase Auth.
- Local department/expense-scoped receipt storage under `data/receipts` for
  development fallback.
- A local department-scoped JSON expense log under `data/expenses.json` for
  development fallback.
- Automatic receipt extraction through OpenAI Vision when `OPENAI_API_KEY` is
  configured.
- A safe manual-review fallback when extraction credentials are not configured.
- A receipt viewer endpoint so stored receipts remain linked to each expense.
- Bank reconciliation fields so logged expenses can be matched against imported
  bank transactions when they post.
- Reconciliation report generation with summary/detail sections and a
  `Reconciled on report` flag for each expense.

## Run locally

### Next.js + Supabase frontend

```bash
cd frontend
npm install
npm run dev
```

Then open http://127.0.0.1:3000.

The Next.js app talks directly to Supabase for Auth, Postgres, and Storage.
Receipt OCR uses the server-only Next route `app/api/extract-receipt`, which
keeps the OpenAI key out of the browser.

Create `frontend/.env.local` from `frontend/.env.local.example`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://qdiktqcpwahtfhrvlncd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_publishable_key
NEXT_PUBLIC_SUPABASE_RECEIPTS_BUCKET=receipts
OPENAI_API_KEY=your_openai_key
OPENAI_RECEIPT_MODEL=gpt-4o-mini
```

### FastAPI prototype

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
| `SUPABASE_RECEIPTS_BUCKET` | `receipts` | Private Supabase Storage bucket for receipt files. |
| `RFD_DEV_AUTH_ENABLED` | `true` | Allows local development login when Supabase is not configured. |
| `RFD_DEV_DEPARTMENT_ID` | `demo-fire-department` | Local development department id. |
| `RFD_DEV_DEPARTMENT_NAME` | `Demo Fire Department` | Local development department name. |
| `OPENAI_API_KEY` | unset | Enables receipt field extraction. |
| `OPENAI_RECEIPT_MODEL` | `gpt-4o-mini` | Vision-capable model for extraction. |

Without `OPENAI_API_KEY`, uploads still work and expenses are logged with
`needs_review` extraction status.

For the configured Supabase project, start from `.env.example`:

```bash
SUPABASE_URL=https://qdiktqcpwahtfhrvlncd.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
RFD_SESSION_SECRET=replace_with_a_long_random_secret
```

## Supabase setup

Run the migrations in `supabase/migrations/` against your Supabase project. They
create:

- `departments`
- `department_members`
- `expenses`
- A private `receipts` storage bucket
- Row Level Security policies that only allow authenticated users to access
  departments, members, expenses, and receipt objects for departments they
  belong to

The signup flow searches department names from Supabase, creates a Supabase Auth
user, and inserts that user's `department_members` row with one of these roles:
Chief, Captain, Lieutenant, Secretary, Treasurer, or Other.

Receipt object paths are designed as:

```text
<department_id>/<year>/<month>/<expense_id>/<receipt_id>.<extension>
```

That keeps every stored receipt tied to both a department and an individual
expense line item. When users sign in through Supabase Auth, the app now writes
expenses through Supabase PostgREST and uploads/reads receipts through Supabase
Storage using that user's access token, so the RLS policies enforce tenant
isolation at the database and object-storage layers.

The review screen mirrors the current hand-written register workflow with fields
for date, check/payment reference, paid-to/vendor, payment amount, tax, running
balance, bank account, fund/budget line, category/purpose, and memo. Confirmed
expenses start with `pending_bank_match` reconciliation status so the future
bank feed integration can match by amount, date, vendor, and account.

Use `/reports/reconciliation` to generate a reconciliation report for a date
range and optional bank account. The report mirrors the sample reconciliation
summary/detail shape with cleared transactions, new/unmatched transactions,
totals, register balance, and a `Reconciled on report` column. Use
`/reports/reconciliation.csv` with the same query parameters to export the
detail rows.

## Next production steps

The repository and storage boundaries now support Supabase in production and a
local fallback for development. The next steps can build on that foundation:

1. Move funds, vendors, reconciliation records, fiscal periods, and report
   outputs into Supabase tables.
2. Add bank feed integration and transaction matching for reconciliation.
3. Add editing/review screens for extracted receipt fields.
4. Build quarterly/yearly summaries, NY 2% reports, and IRS 990
   support.
