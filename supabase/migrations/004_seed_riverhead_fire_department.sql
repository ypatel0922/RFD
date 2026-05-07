insert into public.departments (name)
select 'Riverhead Fire Department'
where not exists (
  select 1
  from public.departments
  where lower(name) = lower('Riverhead Fire Department')
);
