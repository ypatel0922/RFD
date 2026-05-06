create extension if not exists "pgcrypto";

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.department_members (
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (department_id, user_id)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  receipt_id uuid not null,
  receipt_path text not null,
  original_filename text not null,
  content_type text not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid not null references auth.users(id),
  created_by_email text not null,
  uploaded_by text,
  fund text,
  merchant_name text,
  transaction_date date,
  total_amount numeric(12, 2),
  tax_amount numeric(12, 2),
  category text,
  payment_method text,
  extraction_status text not null default 'needs_review',
  extraction_confidence numeric(3, 2) not null default 0,
  extraction_notes text,
  reconciliation_status text not null default 'unreconciled',
  constraint receipt_path_department_prefix
    check (receipt_path like department_id::text || '/%/' || id::text || '/%')
);

create index if not exists department_members_user_id_idx
  on public.department_members(user_id);

create index if not exists expenses_department_created_at_idx
  on public.expenses(department_id, created_at desc);

alter table public.departments enable row level security;
alter table public.department_members enable row level security;
alter table public.expenses enable row level security;

create policy "Members can view their department"
  on public.departments
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = departments.id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can view users in their department"
  on public.department_members
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_members.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can view department expenses"
  on public.expenses
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = expenses.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can create department expenses"
  on public.expenses
  for insert
  with check (
    created_by_user_id = auth.uid()
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = expenses.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update department expenses"
  on public.expenses
  for update
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = expenses.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = expenses.department_id
        and dm.user_id = auth.uid()
    )
  );

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "Members can read department receipt objects"
  on storage.objects
  for select
  using (
    bucket_id = 'receipts'
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = ((storage.foldername(name))[1])::uuid
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can upload department receipt objects"
  on storage.objects
  for insert
  with check (
    bucket_id = 'receipts'
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = ((storage.foldername(name))[1])::uuid
        and dm.user_id = auth.uid()
    )
  );
