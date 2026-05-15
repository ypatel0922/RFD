# RFD Expense Tracker

RFD is a Next.js + Supabase app for fire departments that need lightweight
bookkeeping around receipts and recurring weekly expenses.

This version includes:

- A Next.js frontend backed directly by Supabase Auth, Postgres, and Storage.
- A login screen backed by Supabase Auth.
- A self-service account creation screen with department autocomplete and role
  selection.
- Department membership scoping so each user only sees one department
  dashboard and ledger.
- A two-step capture flow: upload a receipt or take a mobile photo, then review
  autofilled register fields before logging the expense.
- Supabase Postgres expense persistence.
- Supabase Storage uploads/downloads using a private department-scoped
  `receipts` bucket and signed receipt URLs in the ledger/reports.
- Automatic receipt extraction through OpenAI Vision when `OPENAI_API_KEY` is
  configured.
- A safe manual-review fallback when extraction credentials are not configured.
- A receipt viewer endpoint so stored receipts remain linked to each expense.
- Bank reconciliation fields so logged expenses can be matched against imported
  bank transactions when they post.
- Reconciliation report generation with summary/detail sections and a
  `Reconciled on report` flag for each expense.

## Run locally

```bash
npm run install:frontend
npm run dev
```

Then open http://127.0.0.1:3000.

The root npm scripts delegate to the Next.js app in `frontend/`. The Next.js app
talks directly to Supabase for Auth, Postgres, and Storage.
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

Useful commands:

```bash
npm run lint
npm run build
npm run start
```

## Deploy to Vercel

The Next.js app lives in **`frontend/`**. If Vercel’s **Root Directory** is left
at the repository root, installs/builds can succeed from the wrong context or
lag behind what you run locally, so **production may show an older UI**.

1. In Vercel: **Project → Settings → General** → **Root Directory** → set to
   `frontend` → **Save** (this is required).
2. **Settings → Git** → **Production Branch** → choose **`main`** (or whichever
   branch you consider production).
3. **Settings → Environment Variables** → copy everything you use locally
   from `frontend/.env.local.example` (including server keys like
   `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and Plaid vars if you use
   them). Use **Production** (and Preview if you want).
4. Open **Deployments** → confirm the latest **Production** deployment shows the
   same **commit** as `main` on GitHub. If not, click **Redeploy**.
5. On your phone, open the site in a **private/incognito** tab or clear site
   data—mobile browsers cache aggressively.
6. Optional: set `NEXT_PUBLIC_APP_VERSION` in Vercel (e.g. `2026-05-08`) and
   compare the **App version** line in the footer on laptop vs phone.

### Legacy FastAPI prototype

The original FastAPI prototype remains in `app/` while the product is migrated
to Next.js. Use the Next.js app for active development.

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --reload
```

## Configuration

Primary Next.js environment variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | unset | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | unset | Supabase publishable/anon key used by the browser client. |
| `NEXT_PUBLIC_SUPABASE_RECEIPTS_BUCKET` | `receipts` | Private Supabase Storage bucket for receipt files. |
| `OPENAI_API_KEY` | unset | Server-only key used by `frontend/app/api/extract-receipt`. |
| `OPENAI_RECEIPT_MODEL` | `gpt-4o-mini` | Vision-capable model for extraction. |

Legacy FastAPI environment variables:

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
`needs_review` extraction status after user confirmation.

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
- `department_signup_secrets` (department access codes for self-service signup — readable only with the service role / server APIs)
- A private `receipts` storage bucket
- Row Level Security policies that only allow authenticated users to access
  departments, members, expenses, and receipt objects for departments they
  belong to

### Onboarding a new fire department (app owner)

1. Insert the department (or use the SQL editor):
   `insert into public.departments (name) values ('Your FD Name');`
2. Set the signup access code users must enter when creating an account (keep it secret):
   `insert into public.department_signup_secrets (department_id, invite_code) values ('<department-uuid>', 'your-secret-code');`
3. Ensure `SUPABASE_SERVICE_ROLE_KEY` is set in `frontend/.env.local` so `/api/verify-department-invite` and `/api/complete-department-setup` work.

The signup flow collects **name**, **phone**, **email**, **password**, **department**, **role**, and the **department access code**. The first member to finish **Settings** (bank account or Plaid) marks department setup complete for everyone.

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
