create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  name text not null,
  institution_name text,
  account_mask text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists bank_accounts_default_per_department_idx
  on public.bank_accounts(department_id)
  where is_default = true;

create table if not exists public.bank_statement_uploads (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  bank_account_name text,
  statement_start_date date,
  statement_end_date date,
  beginning_balance numeric(12, 2),
  ending_balance numeric(12, 2),
  uploaded_by_user_id uuid not null references auth.users(id),
  uploaded_by_email text not null,
  created_at timestamptz not null default now()
);

alter table public.bank_accounts enable row level security;
alter table public.bank_statement_uploads enable row level security;

drop policy if exists "Members can view department bank accounts" on public.bank_accounts;
create policy "Members can view department bank accounts"
  on public.bank_accounts
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_accounts.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage department bank accounts" on public.bank_accounts;
create policy "Members can manage department bank accounts"
  on public.bank_accounts
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_accounts.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_accounts.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can view statement uploads" on public.bank_statement_uploads;
create policy "Members can view statement uploads"
  on public.bank_statement_uploads
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can create statement uploads" on public.bank_statement_uploads;
create policy "Members can create statement uploads"
  on public.bank_statement_uploads
  for insert
  with check (
    uploaded_by_user_id = auth.uid()
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = bank_statement_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );
