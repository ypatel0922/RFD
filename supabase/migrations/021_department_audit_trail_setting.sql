-- Per-department toggle for audit trail logging (off by default).

alter table public.department_settings
  add column if not exists audit_trail_enabled boolean not null default false;
