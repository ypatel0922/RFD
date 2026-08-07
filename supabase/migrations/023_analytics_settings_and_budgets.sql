-- Analytics dashboard support.
--
-- Adds the two pieces of department-scoped configuration the Analytics tab
-- needs and cannot infer safely from existing data:
--
--   1. department_analytics_settings — the department's own internal 2% fund
--      utilization target and which denominator that target is measured
--      against. This is a planning figure chosen by the department. It is not
--      a legal requirement and nothing here should be presented as one.
--   2. department_budgets — optional per-category annual budget amounts, so
--      budget-vs-actual analytics can use real numbers instead of guesses.
--
-- Nothing existing is renamed, dropped, or rewritten. The 2% account
-- designation already exists (bank_accounts.is_two_percent_account and
-- bank_accounts.fund_type, added in 013_nys_two_percent_fund.sql) and is
-- reused as-is, so accounts are never classified by name matching.

-- ─── department_analytics_settings ───────────────────────────────────────────

create table if not exists public.department_analytics_settings (
  department_id                uuid           primary key references public.departments(id) on delete cascade,
  two_percent_target_percent   numeric(5,2)   not null default 80,
  two_percent_basis            text           not null default 'total_available',
  fiscal_year_start_month      smallint       not null default 1,
  updated_by                   uuid           references auth.users(id),
  created_at                   timestamptz    not null default now(),
  updated_at                   timestamptz    not null default now()
);

do $$ begin
  alter table public.department_analytics_settings
    add constraint department_analytics_settings_target_range_check
      check (two_percent_target_percent >= 0 and two_percent_target_percent <= 100);
exception when duplicate_object then null;
end $$;

-- Which denominator the utilization percentage is measured against:
--   total_available        = carryover balance + current-year receipts
--   current_year_receipts  = current-year receipts only
do $$ begin
  alter table public.department_analytics_settings
    add constraint department_analytics_settings_basis_check
      check (two_percent_basis in ('total_available', 'current_year_receipts'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.department_analytics_settings
    add constraint department_analytics_settings_fiscal_month_check
      check (fiscal_year_start_month between 1 and 12);
exception when duplicate_object then null;
end $$;

alter table public.department_analytics_settings enable row level security;

drop policy if exists "Members can select department analytics settings" on public.department_analytics_settings;
create policy "Members can select department analytics settings"
  on public.department_analytics_settings for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_analytics_settings.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can insert department analytics settings" on public.department_analytics_settings;
create policy "Members can insert department analytics settings"
  on public.department_analytics_settings for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_analytics_settings.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can update department analytics settings" on public.department_analytics_settings;
create policy "Members can update department analytics settings"
  on public.department_analytics_settings for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_analytics_settings.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_analytics_settings.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can delete department analytics settings" on public.department_analytics_settings;
create policy "Members can delete department analytics settings"
  on public.department_analytics_settings for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_analytics_settings.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── department_budgets ──────────────────────────────────────────────────────
--
-- One planned amount per category per fiscal year. `category` stays free text
-- to match expenses.category, which is also free text; normalized_category is
-- the lowercased/whitespace-collapsed form used for joining and uniqueness,
-- following the convention already used by department_categories.

create table if not exists public.department_budgets (
  id                  uuid           primary key default gen_random_uuid(),
  department_id       uuid           not null references public.departments(id) on delete cascade,
  fiscal_year         smallint       not null,
  category            text           not null,
  normalized_category text           not null,
  amount              numeric(12,2)  not null default 0,
  notes               text,
  created_by          uuid           references auth.users(id),
  created_at          timestamptz    not null default now(),
  updated_at          timestamptz    not null default now(),
  unique (department_id, fiscal_year, normalized_category)
);

do $$ begin
  alter table public.department_budgets
    add constraint department_budgets_amount_non_negative_check
      check (amount >= 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.department_budgets
    add constraint department_budgets_fiscal_year_range_check
      check (fiscal_year between 1900 and 2200);
exception when duplicate_object then null;
end $$;

alter table public.department_budgets enable row level security;

drop policy if exists "Members can select department budgets" on public.department_budgets;
create policy "Members can select department budgets"
  on public.department_budgets for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_budgets.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can insert department budgets" on public.department_budgets;
create policy "Members can insert department budgets"
  on public.department_budgets for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_budgets.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can update department budgets" on public.department_budgets;
create policy "Members can update department budgets"
  on public.department_budgets for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_budgets.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_budgets.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can delete department budgets" on public.department_budgets;
create policy "Members can delete department budgets"
  on public.department_budgets for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_budgets.department_id
        and dm.user_id = auth.uid()
    )
  );

create index if not exists department_budgets_department_year_idx
  on public.department_budgets (department_id, fiscal_year);

-- ─── Analytics query support indexes ─────────────────────────────────────────
--
-- Analytics reads expenses by department over a date range, and rolls those
-- rows up by category. The existing indexes cover (department_id, created_at)
-- and (department_id, bank_account_name, transaction_date); neither serves a
-- department-wide date range scan or a category rollup on its own.

create index if not exists expenses_department_transaction_date_idx
  on public.expenses (department_id, transaction_date);

create index if not exists expenses_department_category_idx
  on public.expenses (department_id, category);
