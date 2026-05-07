create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  item_id text not null unique,
  access_token text not null,
  institution_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.external_accounts (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  plaid_item_id uuid references public.plaid_items(id) on delete cascade,
  external_account_id text not null unique,
  name text not null,
  mask text,
  type text not null,
  subtype text,
  source text not null default 'plaid',
  created_at timestamptz not null default now()
);

create table if not exists public.external_transactions (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  external_account_id uuid references public.external_accounts(id) on delete cascade,
  source text not null default 'plaid',
  external_transaction_id text not null unique,
  posted_date date,
  description text,
  amount numeric(12,2),
  pending boolean not null default false,
  expense_id uuid references public.expenses(id) on delete set null,
  match_status text not null default 'unmatched',
  match_confidence numeric(4,3),
  created_at timestamptz not null default now()
);

alter table public.plaid_items enable row level security;
alter table public.external_accounts enable row level security;
alter table public.external_transactions enable row level security;

drop policy if exists "Members can view plaid items" on public.plaid_items;
create policy "Members can view plaid items"
  on public.plaid_items
  for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = plaid_items.department_id and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage plaid items" on public.plaid_items;
create policy "Members can manage plaid items"
  on public.plaid_items
  for all
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = plaid_items.department_id and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = plaid_items.department_id and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage external accounts" on public.external_accounts;
create policy "Members can manage external accounts"
  on public.external_accounts
  for all
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = external_accounts.department_id and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = external_accounts.department_id and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage external transactions" on public.external_transactions;
create policy "Members can manage external transactions"
  on public.external_transactions
  for all
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = external_transactions.department_id and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = external_transactions.department_id and dm.user_id = auth.uid()
    )
  );
