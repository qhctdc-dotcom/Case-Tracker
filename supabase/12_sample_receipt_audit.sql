-- =====================================================================
-- Sample receipt traceability. Run after 03. Safe to run again.
--  * Every sample shows WHO received it, by name (received_by_name).
--  * Every change to a sample's receipt is recorded permanently in
--    sample_audit: logged by courier, received, receipt undone, removed.
--    Undoing a scan no longer erases who did it. Nobody can edit or
--    delete the history; it is written only by the triggers below.
-- =====================================================================

-- ---------- Receiver name, as it was at the time of the scan ----------
alter table public.samples add column if not exists received_by_name text;

-- Staff display name, or the part of the email before "@"
create or replace function public.staff_name(p_email text) returns text
language sql stable security definer set search_path = '' as $$
  select case when coalesce(p_email, '') = '' then null else
    coalesce((select nullif(trim(s.display_name), '') from public.staff s where s.email = lower(p_email)),
             split_part(lower(p_email), '@', 1)) end;
$$;

create or replace function public.samples_stamp_receiver() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.received_by is distinct from old.received_by then
    new.received_by_name := public.staff_name(new.received_by);
  end if;
  return new;
end $$;

drop trigger if exists samples_stamp_receiver on public.samples;
create trigger samples_stamp_receiver before insert or update of received_by on public.samples
for each row execute function public.samples_stamp_receiver();

-- ---------- Audit history ----------
create table if not exists public.sample_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  actor_name text,
  action     text not null,
  sample_id  bigint,          -- no foreign key: history must outlive a deleted sample
  barcode    text not null,
  r_number   text,
  details    jsonb
);
create index if not exists sample_audit_barcode_idx on public.sample_audit(barcode);
create index if not exists sample_audit_sample_idx  on public.sample_audit(sample_id);
create index if not exists sample_audit_at_idx      on public.sample_audit(at desc);

create or replace function public.samples_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor  text := coalesce(nullif(lower(auth.jwt()->>'email'), ''), 'system');
  v_action text; v_details jsonb; v_row public.samples; v_centre text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select name into v_centre from public.centres where id = v_row.centre_id;

  if tg_op = 'INSERT' then
    if new.received_at is not null then
      v_action := 'Received (not logged by courier)';
      v_actor := coalesce(new.received_by, v_actor);
    else
      v_action := 'Logged by courier';
      v_actor := coalesce(new.collected_by, v_actor);
      v_details := jsonb_build_object('centre', v_centre, 'run_id', new.run_id);
    end if;

  elsif tg_op = 'UPDATE' then
    if old.received_at is null and new.received_at is not null then
      v_action := 'Received';
      v_actor := coalesce(new.received_by, v_actor);
      v_details := jsonb_build_object('centre', v_centre, 'collected_by', new.collected_by,
        'collected_at', new.collected_at,
        'transit_minutes', case when new.collected_at is not null
          then round(extract(epoch from (new.received_at - new.collected_at)) / 60) end);
    elsif old.received_at is not null and new.received_at is null then
      v_action := 'Receipt undone';
      v_details := jsonb_build_object('was_received_by', old.received_by,
        'was_received_by_name', old.received_by_name, 'was_received_at', old.received_at);
    else
      return null; -- e.g. photo deleted: not a receipt change
    end if;

  else -- DELETE
    if old.received_at is not null then
      v_action := 'Receipt undone (record removed)';
      v_details := jsonb_build_object('was_received_by', old.received_by,
        'was_received_by_name', old.received_by_name, 'was_received_at', old.received_at);
    else
      v_action := 'Removed by courier';
      v_details := jsonb_build_object('centre', v_centre, 'collected_by', old.collected_by, 'collected_at', old.collected_at);
    end if;
  end if;

  insert into public.sample_audit(actor, actor_name, action, sample_id, barcode, r_number, details)
  values (v_actor, public.staff_name(v_actor), v_action, v_row.id, v_row.barcode, v_row.r_number, v_details);
  return null;
end $$;

drop trigger if exists samples_audit on public.samples;
create trigger samples_audit after insert or update or delete on public.samples
for each row execute function public.samples_audit();

-- ---------- Backfill existing samples ----------
update public.samples set received_by_name = public.staff_name(received_by)
 where received_by is not null and received_by_name is null;

insert into public.sample_audit(at, actor, actor_name, action, sample_id, barcode, r_number, details)
select s.collected_at, s.collected_by, public.staff_name(s.collected_by), 'Logged by courier', s.id, s.barcode, s.r_number,
       jsonb_build_object('backfilled', true, 'run_id', s.run_id)
  from public.samples s
 where s.source = 'courier' and s.collected_at is not null and s.collected_by is not null
   and not exists (select 1 from public.sample_audit a where a.sample_id = s.id);

insert into public.sample_audit(at, actor, actor_name, action, sample_id, barcode, r_number, details)
select s.received_at, s.received_by, public.staff_name(s.received_by),
       case when s.source = 'reception' then 'Received (not logged by courier)' else 'Received' end,
       s.id, s.barcode, s.r_number, jsonb_build_object('backfilled', true)
  from public.samples s
 where s.received_at is not null and s.received_by is not null
   and not exists (select 1 from public.sample_audit a where a.sample_id = s.id and a.action like 'Received%');

-- ---------- Lab staff can read it; nobody can edit or delete it ----------
alter table public.sample_audit enable row level security;
drop policy if exists "lab staff read" on public.sample_audit;
create policy "lab staff read" on public.sample_audit for select to authenticated using ((select public.is_staff()));
revoke all on public.sample_audit from anon, authenticated;
grant select on public.sample_audit to authenticated;

-- Only the triggers use these (they run as the owner)
revoke execute on function public.samples_audit(), public.samples_stamp_receiver(), public.staff_name(text)
  from public, anon, authenticated;

select 'sample receipt audit installed' as result;
