-- =====================================================================
-- Email tracking: daily Meditech "Doctor's Patient Search" uploads for
-- MDS-LANCET LABORATORIES-EMAIL. Stores Req #, Acc # and dates only
-- (no patient names). Run after 01-08. Safe to run again.
--
--   open     -> in the report, not yet worked
--   worked   -> staff marked it worked; if still in a later report it is
--               flagged (duplicate_flag) for removal from Meditech
--   removed  -> staff removed the duplicate in Meditech
--   cleared  -> no longer in the report
-- =====================================================================

create table if not exists public.email_batches (
  id            bigint generated always as identity primary key,
  file_name     text,
  source        text check (source in ('scan','digital','text')),
  run_date      text,
  mode          text not null default 'full' check (mode in ('full','partial')),
  uploaded_by   text not null,
  uploaded_at   timestamptz not null default now(),
  row_count     int not null default 0,
  stats         jsonb,
  undone_at     timestamptz,
  undone_by     text
);

create table if not exists public.email_items (
  id              bigint generated always as identity primary key,
  r_number        text not null unique,
  acc_number      text,
  collection      text,
  entered         text,
  status          text not null default 'open' check (status in ('open','worked','removed','cleared')),
  duplicate_flag  boolean not null default false,
  times_flagged   int not null default 0,
  first_batch_id  bigint references public.email_batches(id),
  last_batch_id   bigint references public.email_batches(id),
  worked_by       text,
  worked_at       timestamptz,
  flagged_at      timestamptz,
  removed_by      text,
  removed_at      timestamptz,
  cleared_at      timestamptz
);
create index if not exists email_items_status_idx on public.email_items(status, duplicate_flag);

-- Previous state of every item an upload changed, for undo
create table if not exists public.email_batch_changes (
  id        bigint generated always as identity primary key,
  batch_id  bigint not null references public.email_batches(id) on delete cascade,
  item_id   bigint not null,
  prev      jsonb            -- null = item was created by this upload
);
create index if not exists email_batch_changes_batch_idx on public.email_batch_changes(batch_id);

-- ---------- Apply an upload ----------
-- p_rows: [{r_number, acc_number, collection, entered}]
create or replace function public.email_apply_upload(p_file_name text, p_source text, p_run_date text, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_batch bigint; v_row jsonb; v_item public.email_items; v_r text; v_acc text;
  v_new int := 0; v_carried int := 0; v_flagged int := 0; v_reopened int := 0; v_cleared int := 0;
  v_stats jsonb;
begin
  if not public.is_staff() then raise exception 'Only lab staff can upload reports' using errcode = '42501'; end if;
  if p_mode not in ('full','partial') then raise exception 'Invalid mode'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The report has no EMAIL rows'; end if;
  perform pg_advisory_xact_lock(hashtext('pat_email_upload'));

  insert into public.email_batches(file_name, source, run_date, mode, uploaded_by, row_count)
  values (p_file_name, p_source, p_run_date, p_mode, v_email, jsonb_array_length(p_rows)) returning id into v_batch;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_r := regexp_replace(coalesce(v_row->>'r_number',''), '[^0-9]', '', 'g');
    continue when length(v_r) < 6;
    v_acc := nullif(v_row->>'acc_number','');

    -- Matched on Req # only. (Acc # is not unique: the same Acc # can appear on
    -- different requisitions, so it is stored for reference but never matched on.)
    select * into v_item from public.email_items where r_number = v_r for update;

    -- Same requisition printed twice in this report: count it once
    if v_item.id is not null and v_item.last_batch_id = v_batch then v_item := null; continue; end if;

    if v_item.id is null then
      insert into public.email_items(r_number, acc_number, collection, entered, status, first_batch_id, last_batch_id)
      values (v_r, v_acc, v_row->>'collection', v_row->>'entered', 'open', v_batch, v_batch) returning * into v_item;
      insert into public.email_batch_changes(batch_id, item_id, prev) values (v_batch, v_item.id, null);
      v_new := v_new + 1;
    else
      insert into public.email_batch_changes(batch_id, item_id, prev) values (v_batch, v_item.id, to_jsonb(v_item));
      if v_item.status = 'open' then
        update public.email_items set last_batch_id = v_batch,
          acc_number = coalesce(v_acc, acc_number), collection = coalesce(v_row->>'collection', collection), entered = coalesce(v_row->>'entered', entered)
        where id = v_item.id;
        v_carried := v_carried + 1;
      elsif v_item.status in ('worked','removed') then
        update public.email_items set last_batch_id = v_batch, status = 'worked', duplicate_flag = true,
          times_flagged = times_flagged + 1, flagged_at = now()
        where id = v_item.id;
        v_flagged := v_flagged + 1;
      else -- cleared earlier, back in the report: treat as new
        update public.email_items set last_batch_id = v_batch, status = 'open', duplicate_flag = false, cleared_at = null,
          worked_by = null, worked_at = null, removed_by = null, removed_at = null,
          acc_number = coalesce(v_acc, acc_number), collection = v_row->>'collection', entered = v_row->>'entered'
        where id = v_item.id;
        v_reopened := v_reopened + 1;
      end if;
    end if;
    v_item := null;
  end loop;

  -- Full report: anything not in it has left Meditech
  if p_mode = 'full' then
    insert into public.email_batch_changes(batch_id, item_id, prev)
    select v_batch, i.id, to_jsonb(i) from public.email_items i
     where i.status <> 'cleared' and i.last_batch_id is distinct from v_batch;
    update public.email_items set status = 'cleared', duplicate_flag = false, cleared_at = now()
     where status <> 'cleared' and last_batch_id is distinct from v_batch;
    get diagnostics v_cleared = row_count;
  end if;

  v_stats := jsonb_build_object('new', v_new, 'carried_over', v_carried, 'flagged', v_flagged, 'back_again', v_reopened,
                                'cleared', v_cleared);
  update public.email_batches set stats = v_stats where id = v_batch;
  return v_stats || jsonb_build_object('batch_id', v_batch);
end $$;

-- ---------- Undo the latest upload ----------
create or replace function public.email_undo_upload()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_b public.email_batches;
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('pat_email_upload'));
  select * into v_b from public.email_batches where undone_at is null order by id desc limit 1;
  if not found then raise exception 'There is no upload to undo'; end if;

  -- Items this upload created: remove them (and their later history is lost with them)
  delete from public.email_items i using public.email_batch_changes c
   where c.batch_id = v_b.id and c.prev is null and i.id = c.item_id;
  -- Items it changed: restore their previous state
  update public.email_items i set
    r_number = c.prev->>'r_number', acc_number = c.prev->>'acc_number', collection = c.prev->>'collection', entered = c.prev->>'entered',
    status = c.prev->>'status', duplicate_flag = (c.prev->>'duplicate_flag')::boolean, times_flagged = (c.prev->>'times_flagged')::int,
    first_batch_id = (c.prev->>'first_batch_id')::bigint, last_batch_id = (c.prev->>'last_batch_id')::bigint,
    worked_by = c.prev->>'worked_by', worked_at = (c.prev->>'worked_at')::timestamptz, flagged_at = (c.prev->>'flagged_at')::timestamptz,
    removed_by = c.prev->>'removed_by', removed_at = (c.prev->>'removed_at')::timestamptz, cleared_at = (c.prev->>'cleared_at')::timestamptz
  from public.email_batch_changes c
  where c.batch_id = v_b.id and c.prev is not null and i.id = c.item_id;

  update public.email_batches set undone_at = now(), undone_by = v_email where id = v_b.id;
  return jsonb_build_object('undone_batch', v_b.id, 'uploaded_at', v_b.uploaded_at);
end $$;

-- ---------- During the day ----------
create or replace function public.email_mark_worked(p_ids bigint[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.email_items set status = 'worked', worked_by = lower(coalesce(auth.jwt()->>'email','')), worked_at = now()
   where id = any(p_ids) and status = 'open';
  get diagnostics v_n = row_count; return v_n;
end $$;

create or replace function public.email_undo_worked(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.email_items set status = 'open', worked_by = null, worked_at = null
   where id = p_id and status = 'worked' and not duplicate_flag;
  if not found then raise exception 'Only worked requisitions that are not flagged can be put back'; end if;
end $$;

create or replace function public.email_mark_removed(p_ids bigint[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.email_items set status = 'removed', duplicate_flag = false, removed_by = lower(coalesce(auth.jwt()->>'email','')), removed_at = now()
   where id = any(p_ids) and duplicate_flag;
  get diagnostics v_n = row_count; return v_n;
end $$;

create or replace function public.email_undo_removed(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.email_items set status = 'worked', duplicate_flag = true, removed_by = null, removed_at = null
   where id = p_id and status = 'removed';
  if not found then raise exception 'Only removed requisitions can be put back on the flagged list'; end if;
end $$;

-- ---------- Row Level Security: lab staff only ----------
alter table public.email_batches       enable row level security;
alter table public.email_items         enable row level security;
alter table public.email_batch_changes enable row level security;
drop policy if exists "staff read" on public.email_batches;
create policy "staff read" on public.email_batches for select to authenticated using ((select public.is_staff()));
drop policy if exists "staff read" on public.email_items;
create policy "staff read" on public.email_items for select to authenticated using ((select public.is_staff()));
drop policy if exists "admin read" on public.email_batch_changes;
create policy "admin read" on public.email_batch_changes for select to authenticated using ((select public.is_admin()));

revoke all on public.email_batches, public.email_items, public.email_batch_changes from anon;
grant select on public.email_batches, public.email_items, public.email_batch_changes to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.email_apply_upload(text, text, text, text, jsonb)', 'public.email_undo_upload()',
    'public.email_mark_worked(bigint[])', 'public.email_undo_worked(bigint)', 'public.email_mark_removed(bigint[])', 'public.email_undo_removed(bigint)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
do $$ begin alter publication supabase_realtime add table public.email_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.email_batches; exception when duplicate_object then null; end $$;

select 'email tracking installed' as result;
