-- Money In: first-class incoming money on the existing ledger.
--
-- Hallix keeps one canonical ledger (public.expenses) for both directions.
-- Money In rows are stored the way bank-statement deposits already are: a
-- negative total_amount. These columns make the economic meaning explicit so
-- analytics no longer has to infer it from names:
--
--   transaction_type = 'income'   money entering the department (counts as income)
--   transaction_type = 'refund'   money returned from a vendor (nets against spend)
--   transaction_type = 'transfer' movement between the department's own accounts
--                                 (affects balances only, never income)
--   transaction_type = 'expense'  money leaving the department
--   transaction_type is null      legacy rows; analytics keeps inferring as before
--
-- Every new column is nullable so existing rows and the expense workflow are
-- untouched.

-- ─── department_counterparties ───────────────────────────────────────────────
-- Generic source / payer model for incoming money. Expense vendors stay in
-- department_vendors; payers are not forced into that expense-only table.

create table if not exists public.department_counterparties (
  id               uuid        primary key default gen_random_uuid(),
  department_id    uuid        not null references public.departments(id) on delete cascade,
  name             text        not null,
  normalized_name  text        not null,
  kind             text        not null default 'payer'
    check (kind in ('payer', 'donor', 'grantor', 'government', 'organization')),
  default_category text,
  notes            text,
  created_from     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (department_id, normalized_name)
);

create index if not exists department_counterparties_department_idx
  on public.department_counterparties (department_id);

alter table public.department_counterparties enable row level security;

drop policy if exists "Members can select department counterparties" on public.department_counterparties;
create policy "Members can select department counterparties"
  on public.department_counterparties for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_counterparties.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can insert department counterparties" on public.department_counterparties;
create policy "Members can insert department counterparties"
  on public.department_counterparties for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_counterparties.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can update department counterparties" on public.department_counterparties;
create policy "Members can update department counterparties"
  on public.department_counterparties for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_counterparties.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_counterparties.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can delete department counterparties" on public.department_counterparties;
create policy "Members can delete department counterparties"
  on public.department_counterparties for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_counterparties.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── expenses: direction, deposit lifecycle, links ───────────────────────────

alter table public.expenses
  add column if not exists transaction_type text,
  add column if not exists deposit_status text,
  add column if not exists deposit_date date,
  add column if not exists counterparty_id uuid
    references public.department_counterparties(id) on delete set null,
  add column if not exists transfer_group_id uuid,
  add column if not exists transfer_account_name text,
  add column if not exists related_expense_id uuid
    references public.expenses(id) on delete set null,
  add column if not exists money_in_details jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'expenses_transaction_type_check'
  ) then
    alter table public.expenses
      add constraint expenses_transaction_type_check
      check (transaction_type is null or transaction_type in ('expense', 'income', 'refund', 'transfer'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'expenses_deposit_status_check'
  ) then
    alter table public.expenses
      add constraint expenses_deposit_status_check
      check (deposit_status is null or deposit_status in ('received', 'deposited'));
  end if;
end $$;

create index if not exists expenses_department_transaction_type_idx
  on public.expenses (department_id, transaction_type);

create index if not exists expenses_counterparty_idx
  on public.expenses (counterparty_id)
  where counterparty_id is not null;

create index if not exists expenses_transfer_group_idx
  on public.expenses (transfer_group_id)
  where transfer_group_id is not null;

comment on column public.expenses.transaction_type is
  'Explicit economic type: expense | income | refund | transfer. Null = legacy row, inferred by analytics.';
comment on column public.expenses.deposit_status is
  'Money In lifecycle: received (in hand, awaiting deposit) | deposited.';
comment on column public.expenses.money_in_details is
  'Secondary Money In fields (document type, donor notes, grant reference, restriction, suggestion audit). Never holds routing or full account numbers.';

-- ─── external_transactions: pending → posted lineage ─────────────────────────
-- Plaid issues a new transaction id when a pending item posts. Keeping the
-- link lets the posted row inherit the pending row's match instead of
-- appearing as a second, double-counted bank item.

alter table public.external_transactions
  add column if not exists pending_transaction_id text,
  add column if not exists superseded_by_id uuid
    references public.external_transactions(id) on delete set null;

create index if not exists external_transactions_pending_txn_idx
  on public.external_transactions (pending_transaction_id)
  where pending_transaction_id is not null;
