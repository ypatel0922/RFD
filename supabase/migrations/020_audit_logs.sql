-- Append-only audit trail for department-scoped user and system actions.

create table if not exists public.audit_logs (
  id              uuid        primary key default gen_random_uuid(),
  department_id   uuid        not null references public.departments(id) on delete cascade,
  user_id         uuid        null,
  user_email      text        null,
  user_role       text        null,
  action          text        not null,
  resource_type   text        not null,
  resource_id     text        null,
  resource_label  text        null,
  before_data     jsonb       null,
  after_data      jsonb       null,
  metadata        jsonb       null,
  ip_address      text        null,
  user_agent      text        null,
  created_at      timestamptz not null default now()
);

create index if not exists audit_logs_department_id_idx on public.audit_logs (department_id);
create index if not exists audit_logs_user_id_idx on public.audit_logs (user_id);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists audit_logs_resource_type_idx on public.audit_logs (resource_type);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);

alter table public.audit_logs enable row level security;

-- Department members may read audit logs for their department only.
create policy "Members can view department audit logs"
  on public.audit_logs
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = audit_logs.department_id
        and dm.user_id = auth.uid()
    )
  );

-- No insert/update/delete policies for authenticated users.
-- Inserts are performed server-side via service role (append-only).
