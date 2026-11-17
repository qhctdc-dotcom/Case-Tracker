-- =====================================================================
-- Email tracking: audit trail (admins only). Run after 09. Safe to run again.
-- Every change to an EMAIL requisition is recorded automatically:
-- who, when, what happened, and which upload it came from.
-- (The Pending tab needs no database change: it shows requisitions that are
--  still not worked and came from an earlier upload.)
-- =====================================================================

create table if not exists public.email_audit (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     text not null,
  action    text not null,
  r_number  text,
  batch_id  bigint,
  details   jsonb
);
create index if not exists email_audit_at_idx on public.email_audit(at desc);
create index if not exists email_audit_r_idx on public.email_audit(r_number);

create or replace function public.email_actor() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(lower(auth.jwt()->>'email'),''), 'system')
$$;

-- ---------- Requisition changes ----------
create or replace function public.email_items_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_action text; v_details jsonb;
begin
  -- An undone upload is recorded once (on the upload), not per requisition
  if coalesce(current_setting('pat.email_undo', true), '') <> '' then return null; end if;

  if tg_op = 'INSERT' then
    v_action := 'Added from report';
  elsif new.status = 'worked' and old.status = 'open' then
    v_action := 'Marked worked';
  elsif new.status = 'open' and old.status = 'worked' then
    v_action := 'Worked undone';
  elsif new.duplicate_flag and new.times_flagged > old.times_flagged then
    v_action := 'Flagged for duplicate removal';
    v_details := jsonb_build_object('times_flagged', new.times_flagged);
  elsif new.status = 'removed' and old.status <> 'removed' then
    v_action := 'Marked removed in Meditech';
  elsif old.status = 'removed' and new.status = 'worked' then
    v_action := 'Removal undone';
  elsif new.status = 'cleared' and old.status <> 'cleared' then
    v_action := 'Cleared (no longer in report)';
    v_details := jsonb_build_object('was', old.status);
  elsif old.status = 'cleared' and new.status = 'open' then
    v_action := 'Back in report';
  else
    return null; -- e.g. carried over unchanged: nothing to record
  end if;

  insert into public.email_audit(actor, action, r_number, batch_id, details)
  values (public.email_actor(), v_action, new.r_number,
          case when tg_op = 'INSERT' or v_action in ('Flagged for duplicate removal','Back in report')
               then new.last_batch_id end,
          v_details);
  return null;
end $$;

drop trigger if exists email_items_audit on public.email_items;
create trigger email_items_audit after insert or update on public.email_items
for each row execute function public.email_items_audit();

-- ---------- Uploads ----------
create or replace function public.email_batches_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.stats is null and new.stats is not null then
    insert into public.email_audit(actor, action, batch_id, details)
    values (new.uploaded_by, 'Uploaded report', new.id,
            jsonb_build_object('file', new.file_name, 'type', new.source, 'mode', new.mode,
                               'report_run', new.run_date, 'rows', new.row_count) || new.stats);
  elsif old.undone_at is null and new.undone_at is not null then
    insert into public.email_audit(actor, action, batch_id, details)
    values (coalesce(new.undone_by, public.email_actor()), 'Upload undone', new.id,
            jsonb_build_object('file', new.file_name, 'uploaded_by', new.uploaded_by, 'uploaded_at', new.uploaded_at));
  end if;
  return null;
end $$;

drop trigger if exists email_batches_audit on public.email_batches;
create trigger email_batches_audit after update on public.email_batches
for each row execute function public.email_batches_audit();

-- Undo: same as before, but marks the session so per-requisition rows are not logged
create or replace function public.email_undo_upload()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_b public.email_batches;
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('pat_email_upload'));
  select * into v_b from public.email_batches where undone_at is null order by id desc limit 1;
  if not found then raise exception 'There is no upload to undo'; end if;

  perform set_config('pat.email_undo', v_b.id::text, true);
  delete from public.email_items i using public.email_batch_changes c
   where c.batch_id = v_b.id and c.prev is null and i.id = c.item_id;
  update public.email_items i set
    r_number = c.prev->>'r_number', acc_number = c.prev->>'acc_number', collection = c.prev->>'collection', entered = c.prev->>'entered',
    status = c.prev->>'status', duplicate_flag = (c.prev->>'duplicate_flag')::boolean, times_flagged = (c.prev->>'times_flagged')::int,
    first_batch_id = (c.prev->>'first_batch_id')::bigint, last_batch_id = (c.prev->>'last_batch_id')::bigint,
    worked_by = c.prev->>'worked_by', worked_at = (c.prev->>'worked_at')::timestamptz, flagged_at = (c.prev->>'flagged_at')::timestamptz,
    removed_by = c.prev->>'removed_by', removed_at = (c.prev->>'removed_at')::timestamptz, cleared_at = (c.prev->>'cleared_at')::timestamptz
  from public.email_batch_changes c
  where c.batch_id = v_b.id and c.prev is not null and i.id = c.item_id;
  perform set_config('pat.email_undo', '', true);

  update public.email_batches set undone_at = now(), undone_by = v_email where id = v_b.id;
  return jsonb_build_object('undone_batch', v_b.id, 'uploaded_at', v_b.uploaded_at);
end $$;
revoke execute on function public.email_undo_upload() from public, anon;
grant execute on function public.email_undo_upload() to authenticated;

-- ---------- Admins only can read it; nobody can edit or delete it ----------
alter table public.email_audit enable row level security;
drop policy if exists "admin read" on public.email_audit;
create policy "admin read" on public.email_audit for select to authenticated using ((select public.is_admin()));
revoke all on public.email_audit from anon, authenticated;
grant select on public.email_audit to authenticated;
revoke execute on function public.email_items_audit(), public.email_batches_audit() from public, anon, authenticated;

select 'email audit installed' as result;
