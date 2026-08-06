-- Monthly bank-statement reconciliation.
--
-- Stores the structured result of reading a paper/photographed bank statement:
-- the session, the per-page extraction state, the consolidated statement lines,
-- and an audit trail. The statement images themselves are never persisted --
-- they are held in memory by the extraction API route and discarded. Only the
-- structured rows below survive, so a reconciliation can be explained later
-- without keeping a copy of the customer's bank statement.

-- ---------------------------------------------------------------------------
-- Bank account reconciliation state
-- ---------------------------------------------------------------------------

alter table public.bank_accounts
  add column if not exists account_type text,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists last_reconciled_statement_end_date date,
  add column if not exists last_reconciled_ending_balance numeric(12, 2);

-- ---------------------------------------------------------------------------
-- Reconciliation sessions
-- ---------------------------------------------------------------------------

create table if not exists public.reconciliation_sessions (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  bank_account_name text,
  source_type text not null default 'monthly_statement',
  statement_start_date date,
  statement_end_date date,
  beginning_balance numeric(12, 2),
  ending_balance numeric(12, 2),
  total_credits numeric(12, 2),
  total_debits numeric(12, 2),
  calculated_ending_balance numeric(12, 2),
  balance_difference numeric(12, 2),
  validation_status text not null default 'not_validated',
  validation_findings jsonb not null default '[]'::jsonb,
  statement_metadata jsonb not null default '{}'::jsonb,
  page_count integer not null default 0,
  extraction_status text not null default 'pending',
  status text not null default 'draft',
  matched_count integer not null default 0,
  needs_review_count integer not null default 0,
  statement_only_count integer not null default 0,
  ledger_only_count integer not null default 0,
  ledger_only_expense_ids jsonb not null default '[]'::jsonb,
  created_by uuid not null references auth.users(id),
  created_by_email text,
  confirmed_by uuid references auth.users(id),
  confirmed_by_email text,
  confirmed_at timestamptz,
  confirmed_transaction_count integer not null default 0,
  override_reason text,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reconciliation_sessions_source_type_check
    check (source_type in ('monthly_statement', 'plaid')),
  constraint reconciliation_sessions_validation_status_check
    check (validation_status in ('not_validated', 'balanced', 'out_of_balance', 'incomplete')),
  constraint reconciliation_sessions_extraction_status_check
    check (extraction_status in ('pending', 'in_progress', 'partial', 'complete', 'failed')),
  constraint reconciliation_sessions_status_check
    check (status in ('draft', 'review', 'confirmed', 'abandoned')),
  constraint reconciliation_sessions_override_requires_reason
    check (
      status <> 'confirmed'
      or validation_status = 'balanced'
      or (override_reason is not null and length(btrim(override_reason)) >= 10)
    )
);

create index if not exists reconciliation_sessions_department_status_idx
  on public.reconciliation_sessions (department_id, status, created_at desc);

create index if not exists reconciliation_sessions_account_period_idx
  on public.reconciliation_sessions (bank_account_id, statement_start_date, statement_end_date);

-- A given account/period may only be confirmed once. Draft sessions are exempt so
-- a treasurer can restart a reconciliation without tripping the constraint.
create unique index if not exists reconciliation_sessions_confirmed_period_idx
  on public.reconciliation_sessions (department_id, bank_account_id, statement_start_date, statement_end_date)
  where status = 'confirmed';

-- Only one open draft per account keeps "resume where you left off" unambiguous.
create unique index if not exists reconciliation_sessions_open_draft_idx
  on public.reconciliation_sessions (department_id, bank_account_id, created_by)
  where status in ('draft', 'review');

-- ---------------------------------------------------------------------------
-- Per-page extraction state (no image bytes, only a digest + structured result)
-- ---------------------------------------------------------------------------

create table if not exists public.reconciliation_session_pages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reconciliation_sessions(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  client_page_id text not null,
  page_order integer not null,
  status text not null default 'pending',
  status_detail text,
  -- sha256 of the preprocessed bytes. Used to detect the same photo uploaded
  -- twice. It is a one-way digest, not a recoverable copy of the image.
  image_digest text,
  extraction_model text,
  extracted_header jsonb,
  extracted_lines jsonb not null default '[]'::jsonb,
  extraction_warnings jsonb not null default '[]'::jsonb,
  line_count integer not null default 0,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reconciliation_session_pages_status_check
    check (status in ('pending', 'reading', 'complete', 'unreadable', 'failed')),
  constraint reconciliation_session_pages_client_page_unique
    unique (session_id, client_page_id)
);

create index if not exists reconciliation_session_pages_session_order_idx
  on public.reconciliation_session_pages (session_id, page_order);

-- ---------------------------------------------------------------------------
-- Consolidated statement lines
-- ---------------------------------------------------------------------------

create table if not exists public.reconciliation_statement_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reconciliation_sessions(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  posted_date date,
  transaction_date date,
  original_description text,
  normalized_description text,
  signed_amount numeric(12, 2),
  debit_amount numeric(12, 2),
  credit_amount numeric(12, 2),
  check_number text,
  reference_number text,
  running_balance numeric(12, 2),
  page_number integer not null,
  row_number integer not null,
  section_heading text,
  extraction_confidence numeric(4, 3),
  extraction_warning text,
  fingerprint text not null,
  match_status text not null default 'unmatched',
  matched_expense_id uuid references public.expenses(id) on delete set null,
  match_score numeric(5, 4),
  match_reasons jsonb not null default '[]'::jsonb,
  candidate_expense_ids jsonb not null default '[]'::jsonb,
  manually_corrected boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reconciliation_statement_lines_match_status_check
    check (match_status in (
      'unmatched',
      'auto_matched',
      'possible_match',
      'manually_matched',
      'ambiguous_duplicate',
      'already_reconciled',
      'outside_period',
      'not_applicable'
    )),
  -- A matched line must carry the expense it matched.
  constraint reconciliation_statement_lines_match_requires_expense
    check (
      match_status not in ('auto_matched', 'manually_matched')
      or matched_expense_id is not null
    )
);

create index if not exists reconciliation_statement_lines_session_order_idx
  on public.reconciliation_statement_lines (session_id, page_number, row_number);

create index if not exists reconciliation_statement_lines_department_idx
  on public.reconciliation_statement_lines (department_id, posted_date);

-- Re-running consolidation must be idempotent: the fingerprint encodes account,
-- date, signed amount, normalized description, reference and occurrence index.
create unique index if not exists reconciliation_statement_lines_session_fingerprint_idx
  on public.reconciliation_statement_lines (session_id, fingerprint);

-- Within one session a Hallix transaction may back at most one statement line.
create unique index if not exists reconciliation_statement_lines_session_expense_idx
  on public.reconciliation_statement_lines (session_id, matched_expense_id)
  where matched_expense_id is not null;

-- Across all sessions a Hallix transaction may only be *confirmed* reconciled once.
create unique index if not exists reconciliation_statement_lines_confirmed_expense_idx
  on public.reconciliation_statement_lines (matched_expense_id)
  where confirmed_at is not null and matched_expense_id is not null;

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

create table if not exists public.reconciliation_audit_events (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  session_id uuid references public.reconciliation_sessions(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_audit_events_session_idx
  on public.reconciliation_audit_events (session_id, created_at desc);

create index if not exists reconciliation_audit_events_department_idx
  on public.reconciliation_audit_events (department_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Expense linkage to a reconciliation session
-- ---------------------------------------------------------------------------

alter table public.expenses
  add column if not exists reconciliation_session_id uuid references public.reconciliation_sessions(id) on delete set null,
  add column if not exists reconciliation_statement_line_id uuid,
  add column if not exists reconciliation_match_reasons jsonb,
  add column if not exists reconciled_by uuid references auth.users(id),
  add column if not exists reconciled_by_email text;

create index if not exists expenses_reconciliation_session_idx
  on public.expenses (reconciliation_session_id)
  where reconciliation_session_id is not null;

create index if not exists expenses_department_account_date_idx
  on public.expenses (department_id, bank_account_name, transaction_date);

-- ---------------------------------------------------------------------------
-- Row level security -- same department-membership model as the rest of the app
-- ---------------------------------------------------------------------------

alter table public.reconciliation_sessions enable row level security;
alter table public.reconciliation_session_pages enable row level security;
alter table public.reconciliation_statement_lines enable row level security;
alter table public.reconciliation_audit_events enable row level security;

drop policy if exists "Members can view department reconciliation sessions" on public.reconciliation_sessions;
create policy "Members can view department reconciliation sessions"
  on public.reconciliation_sessions
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_sessions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can create department reconciliation sessions" on public.reconciliation_sessions;
create policy "Members can create department reconciliation sessions"
  on public.reconciliation_sessions
  for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_sessions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can update department reconciliation sessions" on public.reconciliation_sessions;
create policy "Members can update department reconciliation sessions"
  on public.reconciliation_sessions
  for update
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_sessions.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_sessions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can delete department reconciliation sessions" on public.reconciliation_sessions;
create policy "Members can delete department reconciliation sessions"
  on public.reconciliation_sessions
  for delete
  using (
    status <> 'confirmed'
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_sessions.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage reconciliation session pages" on public.reconciliation_session_pages;
create policy "Members can manage reconciliation session pages"
  on public.reconciliation_session_pages
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_session_pages.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_session_pages.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can manage reconciliation statement lines" on public.reconciliation_statement_lines;
create policy "Members can manage reconciliation statement lines"
  on public.reconciliation_statement_lines
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_statement_lines.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_statement_lines.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can view reconciliation audit events" on public.reconciliation_audit_events;
create policy "Members can view reconciliation audit events"
  on public.reconciliation_audit_events
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_audit_events.department_id
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can append reconciliation audit events" on public.reconciliation_audit_events;
create policy "Members can append reconciliation audit events"
  on public.reconciliation_audit_events
  for insert
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = reconciliation_audit_events.department_id
        and dm.user_id = auth.uid()
    )
  );

-- Audit rows are append-only: no update or delete policy is granted.

-- ---------------------------------------------------------------------------
-- Atomic confirmation
-- ---------------------------------------------------------------------------

-- Marks the approved statement lines and their Hallix transactions reconciled in
-- one transaction. Runs as `security invoker` so the caller's RLS still enforces
-- department isolation; any failure rolls the whole confirmation back so a
-- half-reconciled session is impossible.
create or replace function public.confirm_statement_reconciliation(
  p_session_id uuid,
  p_line_ids uuid[],
  p_override_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.reconciliation_sessions;
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  -- Taken from the verified JWT rather than a caller-supplied argument so the
  -- recorded identity cannot be spoofed by calling this function directly.
  v_actor_email text := nullif(auth.jwt() ->> 'email', '');
  v_confirmed_count integer := 0;
  v_line record;
  v_expense_id uuid;
  v_expense_reconciled boolean;
begin
  select * into v_session
  from public.reconciliation_sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'RECONCILIATION_SESSION_NOT_FOUND';
  end if;

  if v_session.status = 'confirmed' then
    -- Idempotent: a retried confirmation returns the original result instead of
    -- reconciling anything a second time.
    return jsonb_build_object(
      'session_id', v_session.id,
      'already_confirmed', true,
      'confirmed_count', v_session.confirmed_transaction_count,
      'confirmed_at', v_session.confirmed_at
    );
  end if;

  if v_session.status = 'abandoned' then
    raise exception 'RECONCILIATION_SESSION_ABANDONED';
  end if;

  if v_session.validation_status <> 'balanced'
     and (p_override_reason is null or length(btrim(p_override_reason)) < 10) then
    raise exception 'RECONCILIATION_REQUIRES_BALANCED_STATEMENT';
  end if;

  for v_line in
    select l.*
    from public.reconciliation_statement_lines l
    where l.session_id = p_session_id
      and l.id = any(p_line_ids)
      and l.matched_expense_id is not null
      and l.match_status in ('auto_matched', 'manually_matched')
    order by l.page_number, l.row_number
  loop
    -- Reject any transaction already reconciled by an earlier session so the
    -- same expense can never be counted twice. `for update` holds the row for
    -- the rest of this transaction, so a concurrent confirmation of the same
    -- expense waits here and then fails the check rather than double-counting.
    select e.id, (e.reconciliation_status = 'matched' and e.reconciled_at is not null)
      into v_expense_id, v_expense_reconciled
    from public.expenses e
    where e.id = v_line.matched_expense_id
      and e.department_id = v_session.department_id
    for update;

    if v_expense_id is null then
      raise exception 'RECONCILIATION_EXPENSE_NOT_IN_DEPARTMENT';
    end if;

    if coalesce(v_expense_reconciled, false) then
      raise exception 'RECONCILIATION_EXPENSE_ALREADY_RECONCILED';
    end if;

    update public.expenses
    set reconciliation_status = 'matched',
        reconciliation_candidate = false,
        reconciliation_candidate_notes = null,
        reconciliation_similarity = v_line.match_score,
        reconciliation_session_id = v_session.id,
        reconciliation_statement_line_id = v_line.id,
        reconciliation_match_reasons = v_line.match_reasons,
        bank_posted_date = coalesce(v_line.posted_date, v_line.transaction_date),
        bank_description = v_line.original_description,
        bank_amount = v_line.signed_amount,
        bank_match_confidence = least(1, greatest(0, coalesce(v_line.match_score, 0))),
        reconciled_at = v_now,
        reconciled_by = v_actor,
        reconciled_by_email = v_actor_email
    where id = v_line.matched_expense_id;

    update public.reconciliation_statement_lines
    set confirmed_at = v_now,
        updated_at = v_now
    where id = v_line.id;

    v_confirmed_count := v_confirmed_count + 1;
  end loop;

  update public.reconciliation_sessions
  set status = 'confirmed',
      confirmed_by = v_actor,
      confirmed_by_email = v_actor_email,
      confirmed_at = v_now,
      confirmed_transaction_count = v_confirmed_count,
      override_reason = case
        when validation_status = 'balanced' then null
        else btrim(p_override_reason)
      end,
      updated_at = v_now
  where id = p_session_id;

  if v_session.bank_account_id is not null then
    update public.bank_accounts
    set last_reconciled_at = v_now,
        last_reconciled_statement_end_date = v_session.statement_end_date,
        last_reconciled_ending_balance = v_session.ending_balance
    where id = v_session.bank_account_id
      and department_id = v_session.department_id
      and (
        last_reconciled_statement_end_date is null
        or v_session.statement_end_date is null
        or v_session.statement_end_date >= last_reconciled_statement_end_date
      );
  end if;

  insert into public.reconciliation_audit_events
    (department_id, session_id, event_type, actor_user_id, actor_email, detail)
  values (
    v_session.department_id,
    v_session.id,
    'reconciliation_confirmed',
    v_actor,
    v_actor_email,
    jsonb_build_object(
      'confirmed_count', v_confirmed_count,
      'validation_status', v_session.validation_status,
      'balance_difference', v_session.balance_difference,
      'statement_start_date', v_session.statement_start_date,
      'statement_end_date', v_session.statement_end_date,
      'override_reason', case when v_session.validation_status = 'balanced' then null else btrim(p_override_reason) end
    )
  );

  return jsonb_build_object(
    'session_id', v_session.id,
    'already_confirmed', false,
    'confirmed_count', v_confirmed_count,
    'confirmed_at', v_now
  );
end;
$$;

revoke all on function public.confirm_statement_reconciliation(uuid, uuid[], text) from public;
grant execute on function public.confirm_statement_reconciliation(uuid, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Abandoned draft cleanup
-- ---------------------------------------------------------------------------

-- Drafts hold extracted statement rows so a treasurer can resume after a refresh.
-- They are not a permanent record, so anything untouched past `expires_at` is
-- removed. Call from a scheduled job (pg_cron) or on demand.
create or replace function public.purge_expired_reconciliation_drafts()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with deleted as (
    delete from public.reconciliation_sessions
    where status in ('draft', 'review', 'abandoned')
      and expires_at < now()
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke all on function public.purge_expired_reconciliation_drafts() from public;
grant execute on function public.purge_expired_reconciliation_drafts() to service_role;
