-- Onboarding tables for departments migrating from paper logs / spreadsheets.
-- These tables track setup progress, beginning balances, uploaded prior records,
-- and AI-generated suggestions. They are SEPARATE from the live transaction ledger.

-- ─── department_onboarding_profiles ──────────────────────────────────────────

create table if not exists public.department_onboarding_profiles (
  id                uuid        primary key default gen_random_uuid(),
  department_id     uuid        not null references public.departments(id) on delete cascade,
  status            text        not null default 'not_started'
                                check (status in ('not_started', 'in_progress', 'completed')),
  started_at        timestamptz,
  completed_at      timestamptz,
  created_by        uuid        not null references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (department_id)
);

alter table public.department_onboarding_profiles enable row level security;

create policy "Members can select onboarding profile"
  on public.department_onboarding_profiles for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_onboarding_profiles.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert onboarding profile"
  on public.department_onboarding_profiles for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_onboarding_profiles.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update onboarding profile"
  on public.department_onboarding_profiles for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = department_onboarding_profiles.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── onboarding_beginning_balances ───────────────────────────────────────────

create table if not exists public.onboarding_beginning_balances (
  id                uuid        primary key default gen_random_uuid(),
  department_id     uuid        not null references public.departments(id) on delete cascade,
  account_id        uuid        references public.bank_accounts(id) on delete set null,
  account_name      text        not null,
  account_type      text        not null,
  institution       text,
  mask              text,
  beginning_balance numeric     not null,
  balance_date      date        not null,
  is_default        boolean     not null default false,
  created_by        uuid        not null references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.onboarding_beginning_balances enable row level security;

create policy "Members can select beginning balances"
  on public.onboarding_beginning_balances for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_beginning_balances.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert beginning balances"
  on public.onboarding_beginning_balances for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_beginning_balances.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update beginning balances"
  on public.onboarding_beginning_balances for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_beginning_balances.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can delete beginning balances"
  on public.onboarding_beginning_balances for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_beginning_balances.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── onboarding_prior_record_uploads ─────────────────────────────────────────
-- Stores uploaded old registers, notebooks, statements, spreadsheets.
-- Separate from the receipts bucket and the live expense ledger.

create table if not exists public.onboarding_prior_record_uploads (
  id              uuid        primary key default gen_random_uuid(),
  department_id   uuid        not null references public.departments(id) on delete cascade,
  file_path       text        not null,
  file_name       text        not null,
  file_mime_type  text,
  status          text        not null default 'uploaded'
                              check (status in ('uploaded', 'processing', 'reviewed', 'failed')),
  extracted_data  jsonb,
  created_by      uuid        not null references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.onboarding_prior_record_uploads enable row level security;

create policy "Members can select prior uploads"
  on public.onboarding_prior_record_uploads for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_prior_record_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert prior uploads"
  on public.onboarding_prior_record_uploads for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_prior_record_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update prior uploads"
  on public.onboarding_prior_record_uploads for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_prior_record_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can delete prior uploads"
  on public.onboarding_prior_record_uploads for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_prior_record_uploads.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── onboarding_suggestions ──────────────────────────────────────────────────
-- AI-extracted suggestions for accounts, categories, vendors, income types.
-- Users can Accept, Rename, or Ignore each suggestion.

create table if not exists public.onboarding_suggestions (
  id               uuid        primary key default gen_random_uuid(),
  department_id    uuid        not null references public.departments(id) on delete cascade,
  suggestion_type  text        not null
                               check (suggestion_type in ('account', 'category', 'vendor', 'income_type')),
  suggested_value  text        not null,
  confidence       numeric,
  source_upload_id uuid        references public.onboarding_prior_record_uploads(id) on delete set null,
  status           text        not null default 'pending'
                               check (status in ('pending', 'accepted', 'renamed', 'ignored')),
  accepted_value   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.onboarding_suggestions enable row level security;

create policy "Members can select suggestions"
  on public.onboarding_suggestions for select
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_suggestions.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can insert suggestions"
  on public.onboarding_suggestions for insert
  with check (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_suggestions.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can update suggestions"
  on public.onboarding_suggestions for update
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = onboarding_suggestions.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ─── Storage bucket: onboarding ──────────────────────────────────────────────
-- Path convention: onboarding/{department_id}/prior-records/{uuid}-{filename}

insert into storage.buckets (id, name, public)
values ('onboarding', 'onboarding', false)
on conflict (id) do nothing;

create policy "Members can upload onboarding files"
  on storage.objects for insert
  with check (
    bucket_id = 'onboarding'
    and exists (
      select 1 from public.department_members dm
      where dm.department_id = (storage.foldername(name))[1]::uuid
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can read onboarding files"
  on storage.objects for select
  using (
    bucket_id = 'onboarding'
    and exists (
      select 1 from public.department_members dm
      where dm.department_id = (storage.foldername(name))[1]::uuid
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can delete onboarding files"
  on storage.objects for delete
  using (
    bucket_id = 'onboarding'
    and exists (
      select 1 from public.department_members dm
      where dm.department_id = (storage.foldername(name))[1]::uuid
        and dm.user_id = auth.uid()
    )
  );
