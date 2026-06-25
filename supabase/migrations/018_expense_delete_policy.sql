-- Allow department members to delete expenses they can already view and update.

create policy "Members can delete department expenses"
  on public.expenses for delete
  using (
    exists (
      select 1 from public.department_members dm
      where dm.department_id = expenses.department_id
        and dm.user_id = auth.uid()
    )
  );
