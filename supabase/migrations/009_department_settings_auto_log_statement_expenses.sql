create table if not exists public.department_settings (
  department_id uuid primary key references public.departments(id) on delete cascade,
  auto_log_statement_expenses boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.department_settings enable row level security;

drop policy if exists "Members can view department settings" on public.department_settings;
create policy "Members can view department settings"
  on public.department_settings
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_settings.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage department settings" on public.department_settings;
create policy "Members can manage department settings"
  on public.department_settings
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_settings.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = department_settings.department_id
        and dm.user_id = auth.uid()
    )
  );
