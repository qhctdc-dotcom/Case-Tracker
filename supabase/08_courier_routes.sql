-- =====================================================================
-- Courier routes: admin defines routes (ordered sites) and assigns
-- them to couriers. Couriers collect from sites on their routes, or
-- start an EMERGENCY collection at any site (reason required).
-- Run after 01-07. Safe to run again.
-- =====================================================================

create table if not exists public.courier_routes (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.route_sites (
  route_id  bigint not null references public.courier_routes(id) on delete cascade,
  centre_id bigint not null references public.centres(id),
  position  int not null default 0,
  primary key (route_id, centre_id)
);

create table if not exists public.route_assignments (
  route_id      bigint not null references public.courier_routes(id) on delete cascade,
  courier_email text not null,
  primary key (route_id, courier_email)
);

alter table public.courier_runs add column if not exists route_id bigint references public.courier_routes(id);
alter table public.courier_runs add column if not exists is_emergency boolean not null default false;
alter table public.courier_runs add column if not exists emergency_reason text;

-- ---------- Admin: create or update a route in one go ----------
create or replace function public.save_route(p_id bigint, p_name text, p_active boolean, p_centre_ids bigint[], p_couriers text[])
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if not public.is_admin() then raise exception 'Only admins can manage routes' using errcode = '42501'; end if;
  if trim(coalesce(p_name,'')) = '' then raise exception 'Give the route a name'; end if;
  if p_id is null then
    insert into public.courier_routes(name, active) values (trim(p_name), coalesce(p_active, true)) returning id into v_id;
  else
    update public.courier_routes set name = trim(p_name), active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Route not found'; end if;
  end if;

  delete from public.route_sites where route_id = v_id;
  insert into public.route_sites(route_id, centre_id, position)
  select v_id, c, ord::int from unnest(coalesce(p_centre_ids, '{}')) with ordinality as t(c, ord)
  on conflict do nothing;

  delete from public.route_assignments where route_id = v_id;
  insert into public.route_assignments(route_id, courier_email)
  select distinct v_id, lower(trim(e)) from unnest(coalesce(p_couriers, '{}')) e where trim(coalesce(e,'')) <> '';

  insert into public.activity_log(by_email, action, detail)
  values (v_email, 'save_route', jsonb_build_object('route_id', v_id, 'name', trim(p_name),
          'sites', coalesce(p_centre_ids, '{}'), 'couriers', coalesce(p_couriers, '{}')));
  return v_id;
end $$;

-- ---------- Starting a collection: on a route, or as an emergency ----------
drop function if exists public.courier_start_run(bigint);
create or replace function public.courier_start_run(p_centre_id bigint, p_route_id bigint default null,
                                                    p_emergency boolean default false, p_reason text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_id bigint;
begin
  if not (public.is_courier() or public.is_staff()) then raise exception 'Not authorised' using errcode = '42501'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and active) then raise exception 'Unknown or inactive site'; end if;

  if coalesce(p_emergency, false) then
    if trim(coalesce(p_reason,'')) = '' then raise exception 'Give a short reason for the emergency collection'; end if;
    insert into public.courier_runs(courier_email, centre_id, route_id, is_emergency, emergency_reason)
    values (v_email, p_centre_id, null, true, trim(p_reason)) returning id into v_id;
    return v_id;
  end if;

  -- Normal collection: the site must be on one of the courier's assigned, active routes
  if not public.is_staff() then
    if p_route_id is null or not exists (
        select 1 from public.route_assignments a
          join public.courier_routes r on r.id = a.route_id and r.active
          join public.route_sites s on s.route_id = a.route_id and s.centre_id = p_centre_id
         where a.route_id = p_route_id and a.courier_email = v_email) then
      raise exception 'That site is not on a route assigned to you. Use Emergency collection if it is urgent.';
    end if;
  end if;
  insert into public.courier_runs(courier_email, centre_id, route_id) values (v_email, p_centre_id, p_route_id) returning id into v_id;
  return v_id;
end $$;

-- ---------- Row Level Security ----------
alter table public.courier_routes    enable row level security;
alter table public.route_sites       enable row level security;
alter table public.route_assignments enable row level security;

-- Lab staff see all routes; couriers see only routes assigned to them
drop policy if exists "read routes" on public.courier_routes;
create policy "read routes" on public.courier_routes for select to authenticated
  using ((select public.is_staff()) or exists (select 1 from public.route_assignments a
          where a.route_id = courier_routes.id and a.courier_email = lower(coalesce(auth.jwt()->>'email',''))));
drop policy if exists "read route sites" on public.route_sites;
create policy "read route sites" on public.route_sites for select to authenticated
  using ((select public.is_staff()) or exists (select 1 from public.route_assignments a
          where a.route_id = route_sites.route_id and a.courier_email = lower(coalesce(auth.jwt()->>'email',''))));
drop policy if exists "read route assignments" on public.route_assignments;
create policy "read route assignments" on public.route_assignments for select to authenticated
  using ((select public.is_staff()) or courier_email = lower(coalesce(auth.jwt()->>'email','')));

revoke all on public.courier_routes, public.route_sites, public.route_assignments from anon;
grant select on public.courier_routes, public.route_sites, public.route_assignments to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.save_route(bigint, text, boolean, bigint[], text[])',
                           'public.courier_start_run(bigint, bigint, boolean, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select 'courier routes installed' as result;
