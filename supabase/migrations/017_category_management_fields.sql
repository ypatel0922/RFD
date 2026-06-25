-- Extend department_categories for structured category management.
-- Adds 2% guidance, grouping, default type, and visibility without breaking
-- existing category references on expenses (still free-text).

alter table public.department_categories
  add column if not exists description text,
  add column if not exists category_group text not null default 'general',
  add column if not exists default_type text not null default 'expense',
  add column if not exists two_percent_guidance text not null default 'not_two_percent',
  add column if not exists is_system_default boolean not null default false,
  add column if not exists is_active boolean not null default true;

do $$ begin
  alter table public.department_categories
    add constraint department_categories_category_group_check
      check (category_group in ('two_percent', 'general'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.department_categories
    add constraint department_categories_default_type_check
      check (default_type in ('expense', 'income', 'both'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.department_categories
    add constraint department_categories_two_percent_guidance_check
      check (two_percent_guidance in ('likely_eligible', 'needs_review', 'potentially_not_allowed', 'not_two_percent'));
exception when duplicate_object then null;
end $$;

create index if not exists department_categories_group_active_idx
  on public.department_categories (department_id, category_group, is_active);
