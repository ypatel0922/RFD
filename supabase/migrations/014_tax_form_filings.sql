-- Tax Form Filings: tracks all NYS 2% (and future) tax form filings,
-- whether generated inside Firebook or uploaded as a prior-year document.
create table if not exists public.tax_form_filings (
  id                uuid        primary key default gen_random_uuid(),
  department_id     uuid        not null references public.departments(id) on delete cascade,
  tax_form_type     text        not null default 'nys_foreign_fire_insurance',
  tax_year          integer     not null,
  source            text        not null
    check (source in ('generated_firebook', 'uploaded_prior_filing')),
  status            text        not null default 'draft'
    check (status in ('draft', 'saved', 'uploaded', 'archived')),
  file_path         text,       -- path inside the tax-forms storage bucket
  file_name         text,       -- original or generated filename
  file_mime_type    text,       -- e.g. application/pdf, image/jpeg
  extracted_data    jsonb,      -- OCR/extracted entity & financial data
  created_by        uuid        references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One generated filing and one uploaded filing per dept/year/form-type
  unique (department_id, tax_year, tax_form_type, source)
);

alter table public.tax_form_filings enable row level security;

create policy "Members can read department tax form filings"
  on public.tax_form_filings
  for select
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_filings.department_id
        and dm.user_id = auth.uid()
    )
  );

create policy "Members can write department tax form filings"
  on public.tax_form_filings
  for all
  using (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_filings.department_id
        and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.department_members dm
      where dm.department_id = tax_form_filings.department_id
        and dm.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Storage bucket for tax-form files (private, department-scoped)
-- ──────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tax-forms',
  'tax-forms',
  false,
  10485760,  -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']
)
on conflict (id) do nothing;

-- Storage path convention: {department_id}/nys-2-percent/{tax_year}/{filename}
-- The first path segment is always the department_id UUID.

create policy "Members can read their department tax-form files"
  on storage.objects for select
  using (
    bucket_id = 'tax-forms'
    and (
      select exists (
        select 1 from public.department_members dm
        where dm.department_id = (split_part(storage.objects.name, '/', 1))::uuid
          and dm.user_id = auth.uid()
      )
    )
  );

create policy "Members can upload their department tax-form files"
  on storage.objects for insert
  with check (
    bucket_id = 'tax-forms'
    and (
      select exists (
        select 1 from public.department_members dm
        where dm.department_id = (split_part(storage.objects.name, '/', 1))::uuid
          and dm.user_id = auth.uid()
      )
    )
  );

create policy "Members can update their department tax-form files"
  on storage.objects for update
  using (
    bucket_id = 'tax-forms'
    and (
      select exists (
        select 1 from public.department_members dm
        where dm.department_id = (split_part(storage.objects.name, '/', 1))::uuid
          and dm.user_id = auth.uid()
      )
    )
  );

create policy "Members can delete their department tax-form files"
  on storage.objects for delete
  using (
    bucket_id = 'tax-forms'
    and (
      select exists (
        select 1 from public.department_members dm
        where dm.department_id = (split_part(storage.objects.name, '/', 1))::uuid
          and dm.user_id = auth.uid()
      )
    )
  );
