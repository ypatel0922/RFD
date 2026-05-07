create table if not exists public.bank_statement_transactions (
  id uuid primary key default gen_random_uuid(),
  statement_upload_id uuid not null references public.bank_statement_uploads(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  posted_date date,
  description text,
  amount numeric(12, 2),
  balance numeric(12, 2),
  reference text,
  matched_expense_id uuid references public.expenses(id) on delete set null,
  match_status text not null default 'unmatched',
  match_confidence numeric(4, 3),
  created_at timestamptz not null default now()
);

alter table public.bank_statement_transactions enable row level security;

drop policy if exists "Members can view bank statement transactions" on public.bank_statement_transactions;
create policy "Members can view bank statement transactions"
  on public.bank_statement_transactions
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_transactions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can create bank statement transactions" on public.bank_statement_transactions;
create policy "Members can create bank statement transactions"
  on public.bank_statement_transactions
  for insert
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_transactions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can update bank statement transactions" on public.bank_statement_transactions;
create policy "Members can update bank statement transactions"
  on public.bank_statement_transactions
  for update
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_transactions.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_transactions.department_id
        and dm.user_id = auth.uid()
    )
  );
