-- =====================================================================
-- Delay reasons and follow-up. Run after 01. Safe to run again.
--  * Lab staff record WHY an overdue (or late) case was delayed and by
--    how long, one note per requisition + department.
--  * Admins follow each delay up: Open -> Following up -> Resolved,
--    with a follow-up note.
--  * Every change is appended to the note's history, so nothing is lost.
--  * Notes keep a copy of the case details (client, tests, TAT), so they
--    survive the requisition being archived or cleared and the delay
--    statistics stay complete.
-- =====================================================================

create table if not exists public.delay_notes (
  id                  bigint generated always as identity primary key,
  r_number            text not null,
  department          text not null,
  patient_id          text,
  client              text,
  is_alist            boolean not null default false,
  tests               text,
  tat_at              timestamptz,
  reason_category     text not null,
  reason              text not null default '',
  delay_minutes       int  not null check (delay_minutes >= 0),
  expected_at         timestamptz,                 -- TAT + delay: when the result is now expected
  status              text not null default 'open' check (status in ('open','following_up','resolved')),
  recorded_by         text not null,
  recorded_by_name    text,
  recorded_at         timestamptz not null default now(),
  updated_by          text,
  updated_by_name     text,
  updated_at          timestamptz not null default now(),
  follow_up_note      text,
  followed_up_by      text,
  followed_up_by_name text,
  followed_up_at      timestamptz,
  resolved_at         timestamptz,
  history             jsonb not null default '[]'::jsonb,
  unique (r_number, department)
);
create index if not exists delay_notes_recorded_idx on public.delay_notes(recorded_at desc);
create index if not exists delay_notes_status_idx   on public.delay_notes(status);

-- Display name of the signed-in person, or the part of their email before "@"
create or replace function public.delay_actor() returns table (email text, name text)
language sql stable security definer set search_path = '' as $$
  select e, coalesce((select nullif(trim(s.display_name), '') from public.staff s where s.email = e), split_part(e, '@', 1))
    from (select lower(coalesce(auth.jwt()->>'email', '')) as e) x;
$$;

-- ---------- Staff: record or change a delay reason ----------
create or replace function public.save_delay_note(
  p_r_number text, p_department text, p_patient_id text, p_client text, p_is_alist boolean,
  p_tests text, p_tat_at timestamptz, p_category text, p_reason text, p_delay_minutes int
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_me record; v_old public.delay_notes; v_id bigint;
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  if coalesce(trim(p_category), '') = '' then raise exception 'Choose a reason for the delay'; end if;
  if p_delay_minutes is null or p_delay_minutes < 0 then raise exception 'Enter how long the delay is'; end if;
  select * into v_me from public.delay_actor();
  select * into v_old from public.delay_notes where r_number = p_r_number and department = p_department;

  if v_old.id is null then
    insert into public.delay_notes(r_number, department, patient_id, client, is_alist, tests, tat_at,
      reason_category, reason, delay_minutes, expected_at, recorded_by, recorded_by_name, updated_by, updated_by_name, history)
    values (p_r_number, p_department, p_patient_id, p_client, coalesce(p_is_alist, false), p_tests, p_tat_at,
      trim(p_category), coalesce(trim(p_reason), ''), p_delay_minutes,
      case when p_tat_at is not null then p_tat_at + make_interval(mins => p_delay_minutes) end,
      v_me.email, v_me.name, v_me.email, v_me.name,
      jsonb_build_array(jsonb_build_object('at', now(), 'by', v_me.name, 'action', 'Reason recorded',
        'category', trim(p_category), 'reason', coalesce(trim(p_reason), ''), 'delay_minutes', p_delay_minutes)))
    returning id into v_id;
  else
    update public.delay_notes set
      patient_id = coalesce(p_patient_id, patient_id), client = coalesce(p_client, client),
      is_alist = coalesce(p_is_alist, is_alist), tests = coalesce(p_tests, tests), tat_at = coalesce(p_tat_at, tat_at),
      reason_category = trim(p_category), reason = coalesce(trim(p_reason), ''), delay_minutes = p_delay_minutes,
      expected_at = case when coalesce(p_tat_at, tat_at) is not null then coalesce(p_tat_at, tat_at) + make_interval(mins => p_delay_minutes) end,
      -- a changed reason on a resolved delay re-opens it for follow-up
      status = case when status = 'resolved' then 'open' else status end,
      resolved_at = case when status = 'resolved' then null else resolved_at end,
      updated_by = v_me.email, updated_by_name = v_me.name, updated_at = now(),
      history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_me.name, 'action', 'Reason changed',
        'category', trim(p_category), 'reason', coalesce(trim(p_reason), ''), 'delay_minutes', p_delay_minutes,
        'was', jsonb_build_object('category', v_old.reason_category, 'reason', v_old.reason, 'delay_minutes', v_old.delay_minutes)))
    where id = v_old.id;
    v_id := v_old.id;
  end if;
  return v_id;
end $$;

-- ---------- Admins: follow a delay up ----------
create or replace function public.follow_up_delay(p_id bigint, p_status text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me record;
begin
  if not public.is_admin() then raise exception 'Only admins can follow up delays' using errcode = '42501'; end if;
  if p_status not in ('open','following_up','resolved') then raise exception 'Unknown status %', p_status; end if;
  select * into v_me from public.delay_actor();
  update public.delay_notes set
    status = p_status,
    follow_up_note = coalesce(nullif(trim(p_note), ''), follow_up_note),
    followed_up_by = v_me.email, followed_up_by_name = v_me.name, followed_up_at = now(),
    resolved_at = case when p_status = 'resolved' then coalesce(resolved_at, now()) else null end,
    history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_me.name,
      'action', case p_status when 'resolved' then 'Resolved' when 'following_up' then 'Following up' else 'Re-opened' end,
      'note', coalesce(trim(p_note), '')))
  where id = p_id;
  if not found then raise exception 'That delay no longer exists'; end if;
end $$;

-- ---------- Admins: remove a note recorded by mistake ----------
create or replace function public.delete_delay_note(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only admins can remove delay notes' using errcode = '42501'; end if;
  delete from public.delay_notes where id = p_id;
end $$;

-- ---------- Lab staff read; changes only through the functions above ----------
alter table public.delay_notes enable row level security;
drop policy if exists "lab staff read" on public.delay_notes;
create policy "lab staff read" on public.delay_notes for select to authenticated using ((select public.is_staff()));
revoke all on public.delay_notes from anon, authenticated;
grant select on public.delay_notes to authenticated;

revoke execute on function public.delay_actor() from public, anon, authenticated;
do $$ declare f text; begin
  foreach f in array array[
    'public.save_delay_note(text, text, text, text, boolean, text, timestamptz, text, text, int)',
    'public.follow_up_delay(bigint, text, text)',
    'public.delete_delay_note(bigint)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
do $$ begin alter publication supabase_realtime add table public.delay_notes; exception when duplicate_object then null; end $$;

select 'delay notes installed' as result;
