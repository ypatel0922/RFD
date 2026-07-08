-- SMS/MMS receipt collection: receipt_requests and user_notification_prefs

-- Stores per-user SMS notification preferences per department
create table public.user_notification_prefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  sms_receipt_requests_enabled boolean not null default true,
  phone_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, department_id)
);

create index user_notification_prefs_user_idx on public.user_notification_prefs (user_id);
create index user_notification_prefs_dept_idx on public.user_notification_prefs (department_id);

alter table public.user_notification_prefs enable row level security;

create policy "Members can view own notification prefs"
  on public.user_notification_prefs for select
  using (auth.uid() = user_id);

create policy "Members can insert own notification prefs"
  on public.user_notification_prefs for insert
  with check (auth.uid() = user_id);

create policy "Members can update own notification prefs"
  on public.user_notification_prefs for update
  using (auth.uid() = user_id);

-- Tracks outstanding receipt requests sent via SMS
create table public.receipt_requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  -- References external_transactions.id (the Plaid transaction that triggered the request)
  transaction_id uuid not null,
  -- Set when the linked expense is known (either pre-existing or created after receipt received)
  expense_id uuid references public.expenses(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  phone_number text not null,
  request_code text unique not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'expired', 'ignored', 'failed')),
  sent_at timestamptz,
  completed_at timestamptz,
  twilio_message_sid text,
  inbound_message_sid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one pending request per external transaction
create unique index receipt_requests_transaction_pending_idx
  on public.receipt_requests (transaction_id)
  where status = 'pending';

create index receipt_requests_dept_idx on public.receipt_requests (department_id);
create index receipt_requests_phone_idx on public.receipt_requests (phone_number);
create index receipt_requests_status_idx on public.receipt_requests (status);
create index receipt_requests_expense_idx on public.receipt_requests (expense_id);

alter table public.receipt_requests enable row level security;

create policy "Members can view department receipt requests"
  on public.receipt_requests for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = receipt_requests.department_id
        and dm.user_id = auth.uid()
    )
  );

-- Only service role (API routes) may insert/update receipt requests
-- Client-side never writes directly to this table
