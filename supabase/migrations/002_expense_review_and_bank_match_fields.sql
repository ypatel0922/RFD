alter table public.expenses
  add column if not exists payment_reference text,
  add column if not exists payee text,
  add column if not exists description text,
  add column if not exists bank_account_name text,
  add column if not exists balance_after_transaction numeric(12, 2),
  add column if not exists bank_transaction_id text,
  add column if not exists bank_posted_date date,
  add column if not exists bank_description text,
  add column if not exists bank_amount numeric(12, 2),
  add column if not exists bank_match_confidence numeric(3, 2) not null default 0,
  add column if not exists reconciled_at timestamptz;

alter table public.expenses
  alter column reconciliation_status set default 'pending_bank_match';
