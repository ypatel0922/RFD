alter table public.expenses
  add column if not exists reconciliation_candidate boolean not null default false,
  add column if not exists reconciliation_candidate_notes text,
  add column if not exists reconciliation_similarity numeric(4, 3),
  add column if not exists last_manual_edit_reason text,
  add column if not exists last_manual_edit_at timestamptz,
  add column if not exists last_manual_edit_by text;

alter table public.bank_statement_uploads
  add column if not exists statement_file_path text,
  add column if not exists original_filename text,
  add column if not exists content_type text;

insert into storage.buckets (id, name, public)
values ('bank-statements', 'bank-statements', false)
on conflict (id) do nothing;

drop policy if exists "Members can read department bank statement objects" on storage.objects;
create policy "Members can read department bank statement objects"
  on storage.objects
  for select
  using (
    bucket_id = 'bank-statements'
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = ((storage.foldername(name))[1])::uuid
        and dm.user_id = auth.uid()
    )
  );

drop policy if exists "Members can upload department bank statement objects" on storage.objects;
create policy "Members can upload department bank statement objects"
  on storage.objects
  for insert
  with check (
    bucket_id = 'bank-statements'
    and exists (
      select 1
      from public.department_members dm
      where dm.department_id = ((storage.foldername(name))[1])::uuid
        and dm.user_id = auth.uid()
    )
  );
