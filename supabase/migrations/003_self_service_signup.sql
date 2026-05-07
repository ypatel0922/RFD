alter table public.department_members
  drop constraint if exists department_members_role_check;

alter table public.department_members
  add constraint department_members_role_check
  check (role in ('Chief', 'Captain', 'Lieutenant', 'Secretary', 'Treasurer', 'Other', 'member', 'treasurer'));

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'departments'
      and policyname = 'Anyone can search department names'
  ) then
    create policy "Anyone can search department names"
      on public.departments
      for select
      using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'department_members'
      and policyname = 'Users can create their own department membership'
  ) then
    create policy "Users can create their own department membership"
      on public.department_members
      for insert
      with check (
        user_id = auth.uid()
        and role in ('Chief', 'Captain', 'Lieutenant', 'Secretary', 'Treasurer', 'Other')
      );
  end if;
end $$;
