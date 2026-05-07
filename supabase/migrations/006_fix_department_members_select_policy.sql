drop policy if exists "Members can view users in their department" on public.department_members;

create policy "Users can view their own department membership"
  on public.department_members
  for select
  using (user_id = auth.uid());
