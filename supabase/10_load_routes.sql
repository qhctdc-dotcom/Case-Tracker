-- =====================================================================
-- Loads the courier routes and their sites (from Routes.pdf), in order,
-- plus the lab's branches and depots as sites (not on any route).
-- Run after 08_courier_routes.sql. Safe to run again: existing sites are
-- reused (matched ignoring capitals), and each route's site list is
-- replaced with the order below. Courier assignments are NOT changed;
-- assign couriers in Settings > Courier routes.
-- =====================================================================
do $$
declare
  v_routes jsonb := $json$[
    {"route": "East Legon to Spintex Route", "sites": ["Erama Medical", "Neptune Clinic", "Sakumono Trust Clinic", "Chinese Acupuncture Clinic", "Jubail Hospital", "Wellnest Medical", "Admed"]},
    {"route": "East Legon to Asylum Down Route", "sites": ["Dua Hospital", "Impact Clinic", "Patholab", "Medfocus Medical", "Opstra"]},
    {"route": "Airport to Dzorwulu Route", "sites": ["St Andrews", "Nyaho Hospital", "Healthnet", "Sunshine", "Executive Heart", "Careflight Medical", "Care 24 Medical", "Sahel Medical", "Egon German Clinic", "Life Healthcare (Accra Mall)", "Green Health"]},
    {"route": "East Legon to Teshie Route", "sites": ["Medigrace Medical Clinic", "Health Quest Medical", "Medics"]},
    {"route": "East Legon to Osu Route", "sites": ["Ababio Clinic", "Osler Medical", "VRA Hospital", "Accra Medical", "Brainwave Accra Medical", "Acheampong Clinic", "Franklyn Medical", "Healthnet Osu"]},
    {"route": "Urgent and Standby Route", "sites": ["Legon Hospital", "Pentecost Hospital", "Tetteh Quarshie Hosp", "Bloom Medical"]},
    {"route": "East Legon to North Kaneshie Route", "sites": ["Cocoa Clinic", "Holy Trinity Hosp", "Paradise", "Theresa's Clinic"]},
    {"route": "East Legon to Lakeside Route", "sites": ["Yeboah Hospital", "GIDEC", "Del International Hosp", "HAG Medical Hospital", "Health Link Hospital", "Executive Health", "Nova Surgery", "Ghana Canada Med.", "Prolife Chinese", "LOD Medical", "MDS Adjiringanor", "Health Alliaze", "Bemuah Royal Hospital", "Sage Medical", "Garnet Medical", "Nextcare Medical", "Advocate", "Health Squar (SQ)", "Sweeden Ghana", "Ogbojo Polyclinic", "Kharis", "Malikem"]},
    {"route": "East Legon to Oyarifa Route", "sites": ["Focus Orthopedic Hosp", "Pantang Hospital", "Mini Clinic", "Crown Medical", "Atomic Overhead", "McHenlys Medical", "Adenta Trust Clinic", "Divine Medical", "Doc's Medical Centre", "El Mash", "Datwell Medical", "Boston Medical", "New Legon Hosp", "Medicas Hospital", "North Legon Clinic", "Forever Champion", "West Africa", "Classic"]},
    {"route": "East Legon to Nsawam Route", "sites": ["Buck Hospital", "Atomic Hospital", "GA East Hospital", "ACP Clinic", "Ultra Lab", "Ashongman Comm Hosp", "Sam J Hospital", "Medifem"]},
    {"route": "Achimota to Tantra Route", "sites": ["Tantra Community Hosp", "Dome Trust Clinic", "Midway Clinic", "Providence Hospital", "Life Health Care (Achimota Mall)", "Health on Wheels", "GA North", "St John's"]}
  ]$json$;
  v_r jsonb; v_route bigint; v_site text; v_centre bigint; v_pos int;
begin
  for v_r in select * from jsonb_array_elements(v_routes) loop
    select id into v_route from public.courier_routes where lower(name) = lower(v_r->>'route');
    if v_route is null then
      insert into public.courier_routes(name) values (v_r->>'route') returning id into v_route;
    else
      update public.courier_routes set active = true where id = v_route;
    end if;
    delete from public.route_sites where route_id = v_route;
    v_pos := 0;
    for v_site in select jsonb_array_elements_text(v_r->'sites') loop
      v_pos := v_pos + 1;
      select id into v_centre from public.centres where lower(name) = lower(v_site);
      if v_centre is null then
        insert into public.centres(name) values (v_site) returning id into v_centre;
      else
        update public.centres set active = true where id = v_centre;
      end if;
      insert into public.route_sites(route_id, centre_id, position) values (v_route, v_centre, v_pos)
        on conflict (route_id, centre_id) do update set position = excluded.position;
      v_centre := null;
    end loop;
    v_route := null;
  end loop;
end $$;

-- ---------- Branches and depots (sites not on a route) ----------
-- Available for emergency collections and report deliveries. To put any of
-- them on a route, add them in Settings > Courier routes.
do $$
declare v_site text;
begin
  for v_site in select jsonb_array_elements_text($json$["Dansoman Depot", "Korle Bu Branch", "Kumasi Branch", "North Ridge Branch", "Trust Hospital Depot", "Tema Com Depot/Branch", "Tarkwa Branch", "Light House", "Cape Coast Depot", "Sehwi Depot", "Hohoe Depot", "Swedru Depot", "Sunyani Depot", "Takoradi Branch", "Tamale Branch", "Teshie Depot", "Koforidua Depot", "Kasoa Depot", "Kissieman Depot", "Labone Depot", "Spintex Depot", "Adjiriganor Depot", "Tarkwa Depot", "Techiman Depot", "Suntreso Depot", "Afrikiko Depot", "Nsawam Depot", "Tamale Depot", "Sogakope"]$json$::jsonb) loop
    if exists (select 1 from public.centres where lower(name) = lower(v_site)) then
      update public.centres set active = true where lower(name) = lower(v_site);
    else
      insert into public.centres(name) values (v_site);
    end if;
  end loop;
end $$;

-- Check: one row per route with its number of sites
select r.name as route, count(s.centre_id) as sites
  from public.courier_routes r left join public.route_sites s on s.route_id = r.id
 group by r.name order by r.name;

select count(*) as branches_and_depots_loaded from public.centres
 where lower(name) in (select lower(x) from jsonb_array_elements_text($json$["Dansoman Depot", "Korle Bu Branch", "Kumasi Branch", "North Ridge Branch", "Trust Hospital Depot", "Tema Com Depot/Branch", "Tarkwa Branch", "Light House", "Cape Coast Depot", "Sehwi Depot", "Hohoe Depot", "Swedru Depot", "Sunyani Depot", "Takoradi Branch", "Tamale Branch", "Teshie Depot", "Koforidua Depot", "Kasoa Depot", "Kissieman Depot", "Labone Depot", "Spintex Depot", "Adjiriganor Depot", "Tarkwa Depot", "Techiman Depot", "Suntreso Depot", "Afrikiko Depot", "Nsawam Depot", "Tamale Depot", "Sogakope"]$json$::jsonb) x);
