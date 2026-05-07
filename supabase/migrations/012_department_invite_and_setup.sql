-- Owner-provided invite code for self-service signup (readable only via service role; no RLS policies).
create table if not exists public.department_signup_secrets (
  department_id uuid primary key references public.departments(id) on delete cascade,
  invite_code text not null,
  updated_at timestamptz not null default now()
);

alter table public.department_signup_secrets enable row level security;

-- First user / setup tracking: set when bank or Plaid is connected (via API or app).
alter table public.departments
  add column if not exists setup_completed_at timestamptz;
