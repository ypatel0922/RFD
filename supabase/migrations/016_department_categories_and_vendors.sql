-- Persistent department-level categories and vendors.
-- Both tables are populated when users accept onboarding suggestions,
-- and can also be managed independently. They feed autocomplete fields
-- throughout the app, complementing the expense-derived lists.

-- ─── department_categories ───────────────────────────────────────────────────

create table if not exists public.department_categories (
  id              uuid        primary key default gen_random_uuid(),
  department_id   uuid        not null references public.departments(id) on delete cascade,
  name            text        not null,
  normalized_name text        not null,
  created_from    text,       -- 'onboarding', 'manual', etc.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (department_id, normalized_name)
);

alter table public.department_categories enable row level security;

create policy "Members can select department categories"
  on public.department_categories for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_categories.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert department categories"
  on public.department_categories for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_categories.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update department categories"
  on public.department_categories for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_categories.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can delete department categories"
  on public.department_categories for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_categories.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── department_vendors ───────────────────────────────────────────────────────

create table if not exists public.department_vendors (
  id               uuid        primary key default gen_random_uuid(),
  department_id    uuid        not null references public.departments(id) on delete cascade,
  name             text        not null,
  normalized_name  text        not null,
  default_category text,
  created_from     text,       -- 'onboarding', 'manual', etc.
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (department_id, normalized_name)
);

alter table public.department_vendors enable row level security;

create policy "Members can select department vendors"
  on public.department_vendors for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_vendors.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert department vendors"
  on public.department_vendors for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_vendors.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update department vendors"
  on public.department_vendors for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_vendors.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can delete department vendors"
  on public.department_vendors for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_vendors.department_id
        and dm.user_id = auth.uid()
    )
  );
