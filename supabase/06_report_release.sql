-- =====================================================================
-- Report release: post-analytical makes reports available before a
-- courier can pick them up. Run after 01-05. Safe to run again.
--
--   released  -> post-analytical has prepared it for a destination
--   picked_up -> a courier put it on a delivery sheet
--   delivered -> the client received it (status D)
--   returned  -> not delivered (ND / CU / C); back with post-analytical
--   cancelled -> release withdrawn before pick-up
-- =====================================================================

create table if not exists public.report_releases (
  id            bigint generated always as identity primary key,
  r_number      text not null,
  client_name   text,
  destination   text not null,
  released_by   text not null,
  released_at   timestamptz not null default now(),
  status        text not null default 'released' check (status in ('released','picked_up','delivered','returned','cancelled')),
  delivery_id   bigint references public.report_deliveries(id) on delete set null,
  closed_by     text,
  closed_at     timestamptz,
  note          text
);
create index if not exists report_releases_status_idx on public.report_releases(status);
create index if not exists report_releases_r_idx on public.report_releases(r_number);
-- Only one "live" release per report at a time
create unique index if not exists report_releases_one_live on public.report_releases(r_number) where status in ('released','picked_up');

-- ---------- Post-analytical ----------
create or replace function public.release_reports(p_codes text[], p_destination text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_raw text; v_r text; v_client text; v_pending int; v_live public.report_releases;
  v_out jsonb := '[]'::jsonb;
begin
  if not public.is_staff() then raise exception 'Only lab staff can release reports' using errcode = '42501'; end if;
  if trim(coalesce(p_destination,'')) = '' then raise exception 'Choose where the reports are going'; end if;
  foreach v_raw in array coalesce(p_codes, '{}') loop
    v_r := public.barcode_r_number(v_raw);
    if v_r is null then v_out := v_out || jsonb_build_object('code', v_raw, 'result', 'no_r_number'); continue; end if;
    select * into v_live from public.report_releases where r_number = v_r and status in ('released','picked_up');
    if found then
      v_out := v_out || jsonb_build_object('code', v_raw, 'r_number', v_r,
        'result', case when v_live.status = 'released' then 'already_released' else 'already_with_courier' end,
        'destination', v_live.destination);
      continue;
    end if;
    select client_raw into v_client from public.requisitions where r_number = v_r;
    select count(*) into v_pending from public.requisition_tests where r_number = v_r and status = 'Pending';
    insert into public.report_releases(r_number, client_name, destination, released_by)
    values (v_r, nullif(v_client,''), trim(p_destination), v_email);
    v_out := v_out || jsonb_build_object('code', v_raw, 'r_number', v_r, 'result', 'released',
      'client_name', v_client, 'pending_tests', v_pending, 'known_to_tracker', v_client is not null);
  end loop;
  return v_out;
end $$;

create or replace function public.cancel_release(p_id bigint, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.report_releases set status = 'cancelled', closed_by = lower(coalesce(auth.jwt()->>'email','')), closed_at = now(),
         note = nullif(trim(coalesce(p_note,'')),'')
   where id = p_id and status in ('released','returned');
  if not found then raise exception 'Only reports waiting for pick-up, or returned, can be withdrawn'; end if;
end $$;

-- ---------- Courier pick-up: only released reports ----------
create or replace function public.delivery_add_reports(p_sheet_id bigint, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_sheet public.delivery_sheets; v_raw text; v_r text; v_rel public.report_releases; v_existing public.report_deliveries; v_id bigint;
  v_out jsonb := '[]'::jsonb;
begin
  if not public.is_member() then raise exception 'Not authorised' using errcode = '42501'; end if;
  select * into v_sheet from public.delivery_sheets where id = p_sheet_id;
  if not found then raise exception 'Delivery sheet not found'; end if;
  if v_sheet.courier_email <> v_email and not public.is_admin() then raise exception 'This delivery sheet belongs to someone else'; end if;
  if v_sheet.closed_at is not null then raise exception 'This delivery sheet is closed'; end if;

  foreach v_raw in array coalesce(p_codes, '{}') loop
    v_r := public.barcode_r_number(v_raw);
    if v_r is null then v_out := v_out || jsonb_build_object('code', v_raw, 'result', 'no_r_number'); continue; end if;
    select * into v_existing from public.report_deliveries where r_number = v_r and status = 'pending';
    if found then
      v_out := v_out || jsonb_build_object('code', v_raw, 'r_number', v_r,
        'result', case when v_existing.sheet_id = p_sheet_id then 'already_on_this_sheet' else 'already_out_for_delivery' end);
      continue;
    end if;
    select * into v_rel from public.report_releases where r_number = v_r and status = 'released' for update;
    if not found then
      v_out := v_out || jsonb_build_object('code', v_raw, 'r_number', v_r, 'result', 'not_released'); continue;
    end if;
    insert into public.report_deliveries(sheet_id, r_number, barcode_raw, client_name)
    values (p_sheet_id, v_r, v_raw, v_rel.client_name) returning id into v_id;
    update public.report_releases set status = 'picked_up', delivery_id = v_id where id = v_rel.id;
    v_out := v_out || jsonb_build_object('code', v_raw, 'r_number', v_r, 'result', 'added', 'client_name', v_rel.client_name,
      'destination', v_rel.destination,
      'other_destination', lower(trim(v_rel.destination)) <> lower(trim(v_sheet.location)));
  end loop;
  return v_out;
end $$;

-- Removing a report from a sheet puts it back on the released list
create or replace function public.delivery_remove(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if not public.is_member() then raise exception 'Not authorised' using errcode = '42501'; end if;
  update public.report_releases set status = 'released', delivery_id = null
   where delivery_id = p_id and status = 'picked_up'
     and exists (select 1 from public.report_deliveries d join public.delivery_sheets s on s.id = d.sheet_id
                 where d.id = p_id and d.status = 'pending' and s.closed_at is null and (s.courier_email = v_email or public.is_admin()));
  delete from public.report_deliveries d using public.delivery_sheets s
   where d.id = p_id and s.id = d.sheet_id and d.status = 'pending' and s.closed_at is null
     and (s.courier_email = v_email or public.is_admin());
  if not found then raise exception 'Only reports not yet recorded, on your open sheet, can be removed'; end if;
end $$;

-- Recording the outcome also closes the release: delivered, or returned to the lab
create or replace function public.delivery_record(p_id bigint, p_status text, p_receiver_name text, p_receiver_signature text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_row public.report_deliveries; v_sheet public.delivery_sheets;
begin
  if not public.is_member() then raise exception 'Not authorised' using errcode = '42501'; end if;
  if p_status not in ('D','ND','CU','C') then raise exception 'Choose D, ND, CU or C'; end if;
  select * into v_row from public.report_deliveries where id = p_id for update;
  if not found then raise exception 'Report not found'; end if;
  select * into v_sheet from public.delivery_sheets where id = v_row.sheet_id;
  if v_sheet.courier_email <> v_email and not public.is_admin() then raise exception 'This delivery sheet belongs to someone else'; end if;
  if v_sheet.closed_at is not null then raise exception 'This delivery sheet is closed'; end if;
  if p_status = 'D' and (trim(coalesce(p_receiver_name,'')) = '' or coalesce(p_receiver_signature,'') = '') then
    raise exception 'A delivered report needs the receiver''s name and signature';
  end if;
  if p_status <> 'D' and trim(coalesce(p_reason,'')) = '' then raise exception 'Give the reason it was not delivered'; end if;
  if length(coalesce(p_receiver_signature,'')) > 60000 then raise exception 'Signature too large'; end if;
  update public.report_deliveries set
    status = p_status,
    receiver_name = case when p_status = 'D' then trim(p_receiver_name) else nullif(trim(coalesce(p_receiver_name,'')),'') end,
    receiver_signature = case when p_status = 'D' then p_receiver_signature else null end,
    reason = case when p_status = 'D' then nullif(trim(coalesce(p_reason,'')),'') else trim(p_reason) end,
    recorded_at = now()
  where id = p_id;
  update public.report_releases set
    status = case when p_status = 'D' then 'delivered' else 'returned' end,
    closed_at = now(), closed_by = v_email,
    note = case when p_status = 'D' then note else p_status || ': ' || trim(p_reason) end
  where delivery_id = p_id and status = 'picked_up';
end $$;

-- ---------- Row Level Security ----------
alter table public.report_releases enable row level security;
drop policy if exists "members read releases" on public.report_releases;
-- Couriers need to see what is waiting for them; lab staff see everything
create policy "members read releases" on public.report_releases for select to authenticated
  using ((select public.is_staff()) or ((select public.is_courier()) and status in ('released','picked_up')));
revoke all on public.report_releases from anon;
grant select on public.report_releases to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.release_reports(text[], text)', 'public.cancel_release(bigint, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
do $$ begin alter publication supabase_realtime add table public.report_releases; exception when duplicate_object then null; end $$;

select 'report release installed' as result;
