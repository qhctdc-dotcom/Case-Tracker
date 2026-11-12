-- =====================================================================
-- Wall display (TV) accounts: read-only, incoming samples only.
-- Run after 01-06. Safe to run again.
-- =====================================================================

-- Add the 'display' role
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('staff','admin','courier','display'));

create or replace function public.is_display() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s
                 where s.email = lower(coalesce(auth.jwt()->>'email','')) and s.active and s.role = 'display');
$$;
revoke execute on function public.is_display() from public, anon;
grant execute on function public.is_display() to authenticated;

-- A display account can read collection runs and samples (nothing else).
-- It cannot open pickup photos (the photo bucket is lab staff only) and
-- cannot see the tracker, reports, deliveries, staff or settings tables
-- beyond what every signed-in member already sees (centres, app settings).
drop policy if exists "display reads runs" on public.courier_runs;
create policy "display reads runs" on public.courier_runs for select to authenticated
  using ((select public.is_display()));
drop policy if exists "display reads samples" on public.samples;
create policy "display reads samples" on public.samples for select to authenticated
  using ((select public.is_display()));

select 'wall display installed' as result;
