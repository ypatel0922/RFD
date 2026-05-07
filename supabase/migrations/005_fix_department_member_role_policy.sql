alter table public.department_members
  drop constraint if exists department_members_role_check;

alter table public.department_members
  add constraint department_members_role_check
  check (lower(role) in ('chief', 'captain', 'lieutenant', 'secretary', 'treasurer', 'other', 'member'));

drop policy if exists "Users can create their own department membership" on public.department_members;

create policy "Users can create their own department membership"
  on public.department_members
  for insert
  with check (
    user_id = auth.uid()
    and lower(role) in ('chief', 'captain', 'lieutenant', 'secretary', 'treasurer', 'other')
  );
