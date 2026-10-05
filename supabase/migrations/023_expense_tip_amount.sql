-- Tip (gratuity) support for receipt expenses.
--
-- total_amount keeps its existing meaning: the final amount charged, which now
-- includes any tip. base_amount and tip_amount record how that total was
-- reached so a restaurant receipt can show $90.95 + $18.00 = $108.95 instead of
-- collapsing to a single figure.
--
-- Non-destructive: both columns are nullable and existing rows stay valid, with
-- a null tip meaning "no tip recorded". RLS is inherited from public.expenses
-- and is intentionally left untouched.

alter table public.expenses
  add column if not exists base_amount numeric(12, 2);

alter table public.expenses
  add column if not exists tip_amount numeric(12, 2);

comment on column public.expenses.base_amount is
  'Printed receipt amount before any tip. Null for expenses logged without a tip breakdown.';

comment on column public.expenses.tip_amount is
  'Gratuity included in total_amount. Null when no tip was recorded.';
