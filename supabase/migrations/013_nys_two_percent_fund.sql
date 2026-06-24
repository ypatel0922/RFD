-- NYS 2% Foreign Fire Insurance Fund account tagging and expense tracking
-- Adds fields for tagging accounts as 2% accounts and tracking 2% fund metadata on expenses

-- bank_accounts: allow a department to designate one or more accounts as NYS 2% / Foreign Fire Insurance Fund accounts
alter table public.bank_accounts
  add column if not exists is_two_percent_account boolean not null default false,
  add column if not exists fund_type text;

-- expenses: 2% fund tracking metadata
alter table public.expenses
  add column if not exists uses_two_percent_funds boolean not null default false,
  add column if not exists two_percent_review_status text,
  add column if not exists two_percent_warning_reason text,
  add column if not exists member_vote_recorded boolean,
  add column if not exists meeting_date date,
  add column if not exists support_note text;

-- Constrain review status to valid values
alter table public.expenses
  drop constraint if exists expenses_two_percent_review_status_check;
alter table public.expenses
  add constraint expenses_two_percent_review_status_check
  check (
    two_percent_review_status is null
    or two_percent_review_status in ('likely_eligible', 'needs_review', 'potentially_not_allowed')
  );

-- Index for querying all 2% fund expenses for a department (used by annual report and dashboard)
create index if not exists expenses_two_percent_idx
  on public.expenses(department_id, uses_two_percent_funds)
  where uses_two_percent_funds = true;
