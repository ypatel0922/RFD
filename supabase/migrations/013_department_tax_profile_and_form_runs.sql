-- Department Tax Profile: stores reusable entity/treasurer data for tax filings
create table if not exists public.department_tax_profiles (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  department_name text,
  address text,
  city text,
  county text,
  zip text,
  entity_type text,
  treasurer_name text,
  treasurer_email text,
  treasurer_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id)
);

alter table public.department_tax_profiles enable row level security;

create policy "Members can read department tax profile"
  on public.department_tax_profiles
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_tax_profiles.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can write department tax profile"
  on public.department_tax_profiles
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_tax_profiles.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_tax_profiles.department_id
        and dm.user_id = auth.uid()
    )
  );

-- Tax Form Runs: one row per department per tax year (draft or final)
create table if not exists public.tax_form_runs (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  tax_year integer not null,
  starting_balance numeric(12, 2) not null default 0,
  revenue_total numeric(12, 2) not null default 0,
  expense_total numeric(12, 2) not null default 0,
  ending_balance numeric(12, 2) not null default 0,
  generated_pdf text,
  status text not null default 'draft',
  form_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, tax_year)
);

alter table public.tax_form_runs enable row level security;

create policy "Members can read department tax form runs"
  on public.tax_form_runs
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_runs.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can write department tax form runs"
  on public.tax_form_runs
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_runs.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_runs.department_id
        and dm.user_id = auth.uid()
    )
  );
