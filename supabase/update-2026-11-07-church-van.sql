-- Update for an EXISTING Chosen Generation Rides database (7 Nov 2026): the church van.
-- The van is a vehicle in the plan (parked at church, up to 14 passengers), a leader chooses who
-- drives it each service day, and it can take people home after the service.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- church van
-- The van is a "vehicle" profile (not a person): it never signs in, is always cleared, and is
-- parked at the church. For each service day a leader chooses who drives it (van_shifts); that
-- person's own car isn't used that day. The van can also take people home after the service.
alter table profiles add column if not exists is_vehicle boolean not null default false;
create unique index if not exists profiles_one_van on profiles ((true)) where is_vehicle;

create table if not exists van_shifts (
  sunday          date primary key,                                   -- the service date
  driver_id       uuid references profiles (id) on delete set null,    -- who drives the van that day
  home_depart_min int,                                                 -- when it leaves church to take people home
  updated_at      timestamptz not null default now()
);

create table if not exists home_rides (
  plan_id    uuid not null references plans (id) on delete cascade,
  rider_id   uuid not null references profiles (id) on delete cascade,
  stop_order int not null default 0,
  drop_min   int,                       -- estimated drop-off time, minutes after midnight
  seats      int not null default 1 check (seats >= 1),
  primary key (plan_id, rider_id)
);

alter table van_shifts enable row level security;
alter table home_rides enable row level security;
drop policy if exists van_shifts_leader on van_shifts;
create policy van_shifts_leader on van_shifts for select using (is_leader());
drop policy if exists home_rides_leader on home_rides;
create policy home_rides_leader on home_rides for select using (is_leader());

-- Leaders: add the church van, or change its seats or where it's parked.
create or replace function set_church_van(p_seats int, p_address text, p_lat double precision, p_lng double precision)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare vid uuid;
begin
  if not is_leader() then raise exception 'Only leaders can set up the church van.'; end if;
  if p_seats is null or p_seats < 1 or p_seats > 14 then raise exception 'Seats must be between 1 and 14 (not counting the driver).'; end if;
  if p_lat is null or p_lng is null then raise exception 'Where is the van parked? The church location is missing.'; end if;
  select id into vid from profiles where is_vehicle;
  if vid is null then
    insert into profiles (full_name, role, is_vehicle, driver_status, seats, second_trip, drives_every_week, vehicle,
                          home_address, lat, lng, geo_source, licence_ok, insurance_ok)
    values ('Church van', 'driver', true, 'cleared', p_seats, true, true, 'Church van',
            coalesce(nullif(p_address, ''), 'Church'), p_lat, p_lng, 'manual', true, true)
    returning id into vid;
  else
    update profiles set seats = p_seats, home_address = coalesce(nullif(p_address, ''), home_address), lat = p_lat, lng = p_lng where id = vid;
  end if;
  return vid;
end $$;

-- Leaders: who drives the van on a service day (null = nobody), and when it leaves church to take people home.
create or replace function set_van_driver(p_sunday date, p_driver uuid, p_home_depart_min int default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can choose the van driver.'; end if;
  if p_driver is not null and not exists (
    select 1 from profiles where id = p_driver and not is_vehicle and driver_status = 'cleared' and role in ('driver', 'leader')) then
    raise exception 'Only a cleared driver can drive the church van.';
  end if;
  if p_driver is null and p_home_depart_min is null then
    delete from van_shifts where sunday = p_sunday;
  else
    insert into van_shifts (sunday, driver_id, home_depart_min) values (p_sunday, p_driver, p_home_depart_min)
    on conflict (sunday) do update set driver_id = excluded.driver_id, home_depart_min = excluded.home_depart_min, updated_at = now();
  end if;
  return 'ok';
end $$;

-- Leaders: the van's rides home after the service, saved with the plan.
create or replace function save_home_rides(p_sunday date, p_rides jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid; n int;
begin
  if not is_leader() then raise exception 'Only leaders can save the plan.'; end if;
  select id into pid from plans where sunday = p_sunday;
  if pid is null then raise exception 'Save the plan for that day first.'; end if;
  delete from home_rides where plan_id = pid;
  insert into home_rides (plan_id, rider_id, stop_order, drop_min, seats)
  select pid, (e ->> 'riderId')::uuid, coalesce((e ->> 'order')::int, 0), (e ->> 'dropMin')::int, greatest(coalesce((e ->> 'seats')::int, 1), 1)
  from jsonb_array_elements(coalesce(p_rides, '[]'::jsonb)) e;
  get diagnostics n = row_count;
  if n > 0 and exists (select 1 from plans where id = pid and status = 'approved')
     and not exists (select 1 from van_shifts where sunday = p_sunday and driver_id is not null) then
    raise exception 'Choose who drives the church van before approving rides home.';
  end if;
  if (select coalesce(sum(seats), 0) from home_rides where plan_id = pid) > (select coalesce(max(seats), 0) from profiles where is_vehicle) then
    raise exception 'More people going home in the van than it has seats.';
  end if;
  return n;
end $$;

-- The van driver's list of people to take home (approved plans only).
create or replace function my_van_home(p_sunday date)
returns table (stop_order int, drop_min int, depart_min int, rider_name text, rider_phone text, address text,
               neighbourhood text, lat double precision, lng double precision, seats int, rider_notes text)
language sql stable security definer set search_path = public, pg_temp as $$
  select h.stop_order, h.drop_min, s.home_depart_min, r.full_name, r.phone, r.home_address, r.neighbourhood, r.lat, r.lng, h.seats, r.notes
  from home_rides h
  join plans p on p.id = h.plan_id and p.status = 'approved' and p.sunday = p_sunday
  join van_shifts s on s.sunday = p.sunday
  join profiles me on me.id = s.driver_id and me.user_id = auth.uid()
  join profiles r on r.id = h.rider_id
  left join ride_requests q on q.rider_id = h.rider_id and q.sunday = p.sunday
  where coalesce(q.status, 'requested') <> 'cancelled'
  order by h.stop_order
$$;

-- A rider's own rides. For the church van, the "driver" is whoever drives the van that day.
drop function if exists my_rides();
create function my_rides()
returns table (sunday date, status text, ride_home boolean, note text, extra_people int, can_split boolean,
               driver_name text, driver_phone text, vehicle text,
               seats int, trip int, pickup_min int, ready_by_min int, arrive_min int, waitlisted_seats int,
               in_van boolean, home_drop_min int, home_depart_min int, home_driver_name text, home_driver_phone text)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.sunday,
         case when r.status = 'cancelled' then 'cancelled'
              when p.status = 'approved' and a.id is not null then 'seated'
              when p.status = 'approved' and w.rider_id is not null then 'waitlisted'
              else 'requested' end,
         r.ride_home, r.note, r.extra_people, r.can_split,
         case when r.status <> 'cancelled' and p.status = 'approved' then coalesce(vd.full_name, d.full_name) end,
         case when r.status <> 'cancelled' and p.status = 'approved' then case when d.is_vehicle then vd.phone else d.phone end end,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.vehicle end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.seats end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.trip end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.pickup_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.ready_by_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.arrive_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then w.seats end,
         coalesce(d.is_vehicle, false),
         case when r.status <> 'cancelled' and p.status = 'approved' then h.drop_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' and h.rider_id is not null then s.home_depart_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' and h.rider_id is not null then hd.full_name end,
         case when r.status <> 'cancelled' and p.status = 'approved' and h.rider_id is not null then hd.phone end
  from ride_requests r
  join profiles me on me.id = r.rider_id and me.user_id = auth.uid()
  left join plans p on p.sunday = r.sunday
  left join assignments a on a.plan_id = p.id and a.rider_id = r.rider_id
  left join profiles d on d.id = a.driver_id
  left join van_shifts s on s.sunday = r.sunday
  left join profiles vd on d.is_vehicle and vd.id = s.driver_id
  left join home_rides h on h.plan_id = p.id and h.rider_id = r.rider_id
  left join profiles hd on h.rider_id is not null and hd.id = s.driver_id
  left join waitlist w on w.plan_id = p.id and w.rider_id = r.rider_id
  where r.sunday >= today_regina()
  order by r.sunday, a.trip, a.stop_order
$$;

-- A driver's pickup list for one Sunday: ONLY their own riders (plus the church van's, on a day
-- they drive it), ONLY after approval.
drop function if exists my_route(date);
create function my_route(p_sunday date)
returns table (trip int, stop_order int, pickup_min int, ready_by_min int, arrive_min int, depart_min int,
               rider_name text, rider_phone text, address text, neighbourhood text,
               lat double precision, lng double precision,
               minor boolean,
               rider_notes text, request_note text, ride_home boolean, extra_people int, seats int, party_total int,
               in_van boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.trip, a.stop_order, a.pickup_min, a.ready_by_min, a.arrive_min, a.depart_min,
         r.full_name, r.phone, r.home_address, r.neighbourhood, r.lat, r.lng,
         r.minor,
         r.notes, q.note, coalesce(q.ride_home, false), coalesce(q.extra_people, 0), a.seats, 1 + coalesce(q.extra_people, 0),
         d.is_vehicle
  from assignments a
  join plans p on p.id = a.plan_id and p.status = 'approved' and p.sunday = p_sunday
  join profiles d on d.id = a.driver_id
  join profiles me on me.user_id = auth.uid()
  join profiles r on r.id = a.rider_id
  left join van_shifts s on s.sunday = p.sunday
  left join ride_requests q on q.rider_id = a.rider_id and q.sunday = p.sunday
  where (a.driver_id = me.id or (d.is_vehicle and s.driver_id = me.id))
    and coalesce(q.status, 'requested') <> 'cancelled'
  order by d.is_vehicle, a.trip, a.stop_order
$$;

create or replace function save_plan(p_sunday date, p_status text, p_summary jsonb,
                                     p_assignments jsonb, p_waitlist jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid;
begin
  if not is_leader() then raise exception 'Only the transport leader can save a plan.'; end if;
  if p_status not in ('draft', 'approved') then raise exception 'Status must be draft or approved.'; end if;

  insert into plans (sunday, status, summary, approved_at)
  values (p_sunday, p_status, coalesce(p_summary, '{}'::jsonb), case when p_status = 'approved' then now() end)
  on conflict (sunday) do update
    set status = excluded.status,
        summary = excluded.summary,
        approved_at = case when excluded.status = 'approved' then coalesce(plans.approved_at, now()) end
  returning id into pid;

  delete from assignments where plan_id = pid;
  delete from waitlist where plan_id = pid;

  insert into assignments (plan_id, rider_id, driver_id, trip, stop_order, pickup_min, ready_by_min, arrive_min, depart_min, seats)
  select pid, (e ->> 'riderId')::uuid, (e ->> 'driverId')::uuid, coalesce((e ->> 'trip')::int, 1),
         coalesce((e ->> 'order')::int, 0), (e ->> 'pickupMin')::int, (e ->> 'readyByMin')::int, (e ->> 'arriveMin')::int,
         (e ->> 'departMin')::int,
         greatest(coalesce((e ->> 'seats')::int, 1), 1)
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  insert into waitlist (plan_id, rider_id, reason, seats)
  select pid, (e ->> 'riderId')::uuid, e ->> 'reason', greatest(coalesce((e ->> 'seats')::int, 1), 1)
  from jsonb_array_elements(coalesce(p_waitlist, '[]'::jsonb)) e
  on conflict do nothing;

  if exists (
    select 1 from assignments a join profiles d on d.id = a.driver_id
    where a.plan_id = pid and d.driver_status <> 'cleared'
  ) then
    raise exception 'Only cleared drivers can be given riders.';
  end if;

  if exists (
    select 1 from (
      select driver_id, trip, sum(seats) c from assignments where plan_id = pid group by 1, 2) x
    join profiles d on d.id = x.driver_id where x.c > d.seats
  ) then
    raise exception 'A car has more people than seats (counting everyone coming with each rider).';
  end if;

  if p_status = 'approved'
     and exists (select 1 from assignments a join profiles d on d.id = a.driver_id where a.plan_id = pid and d.is_vehicle)
     and not exists (select 1 from van_shifts where sunday = p_sunday and driver_id is not null) then
    raise exception 'Choose who drives the church van before approving.';
  end if;

  return pid;
end $$;

create or replace function driver_cant_make_it(p_sunday date, p_note text default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; n int;
begin
  select * into me from profiles where user_id = auth.uid() and (role = 'driver' or (role = 'leader' and seats > 0));
  if not found then raise exception 'Only drivers can use this.'; end if;
  insert into driver_weeks (driver_id, sunday, available, note) values (me.id, p_sunday, false, p_note)
  on conflict (driver_id, sunday) do update set available = false, note = excluded.note;
  select count(*) into n from assignments a join plans p on p.id = a.plan_id
   where p.sunday = p_sunday and a.driver_id = me.id;
  -- Driving the church van that day? Then the van has no driver now, and its riders need one.
  if exists (select 1 from van_shifts where sunday = p_sunday and driver_id = me.id) then
    update van_shifts set driver_id = null, updated_at = now() where sunday = p_sunday;
    n := n + (select count(*) from assignments a join plans p on p.id = a.plan_id join profiles d on d.id = a.driver_id
               where p.sunday = p_sunday and d.is_vehicle);
    insert into alerts (kind, sunday, driver_id, message)
    values ('driver_cancel', p_sunday, me.id,
            me.full_name || ' can''t drive the church van on ' || p_sunday || '. Choose another van driver in the Plan tab.'
            || coalesce(' Note: ' || p_note, ''));
    return n;
  end if;
  insert into alerts (kind, sunday, driver_id, message)
  values ('driver_cancel', p_sunday, me.id,
          me.full_name || ' can''t make it on ' || p_sunday || '. ' || n || ' rider(s) need a new ride.'
          || coalesce(' Note: ' || p_note, ''));
  return n;
end $$;

create or replace function alert_on_rider_cancel() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text; dn text; seat record; notify uuid;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    select x.driver_id, x.pickup_min, p.status as plan_status into seat from assignments x join plans p on p.id = x.plan_id
     where p.sunday = new.sunday and x.rider_id = new.rider_id order by x.trip limit 1;
    delete from assignments x using plans p where p.id = x.plan_id and p.sunday = new.sunday and x.rider_id = new.rider_id;
    delete from waitlist w using plans p where p.id = w.plan_id and p.sunday = new.sunday and w.rider_id = new.rider_id;
    if seat.driver_id is not null then
      select full_name into nm from profiles where id = new.rider_id;
      select case when is_vehicle then 'the church van' else full_name end into dn from profiles where id = seat.driver_id;
      -- Who to tell: the driver, or for the church van whoever drives it that day.
      select case when d.is_vehicle then (select v.driver_id from van_shifts v where v.sunday = new.sunday) else d.id end
        into notify from profiles d where d.id = seat.driver_id;
      insert into alerts (kind, sunday, rider_id, driver_id, message)
      values ('rider_cancel', new.sunday, new.rider_id, seat.driver_id,
        nm || ' cancelled their ride for ' || to_char(new.sunday, 'FMDay, FMMonth FMDD') || '. They were in ' || case when dn = 'the church van' then dn else dn || '''s car' end
        || coalesce(' (pickup ' || to_char(time '00:00' + make_interval(mins => seat.pickup_min), 'FMHH12:MI AM') || ')', '') || '.');
      -- The driver already had this rider on their list (the plan was shared): tell them straight away.
      if seat.plan_status = 'approved' and to_regclass('public.push_queue') is not null
         and notify is not null and exists (select 1 from push_subs s where s.profile_id = notify) then
        insert into push_queue (profile_id, title, body, tag)
        values (notify, 'Change to your pickups',
          split_part(nm, ' ', 1) || ' cancelled their ride for ' || to_char(new.sunday, 'FMDay') || ', so you don''t need to pick them up. Open the app for your updated list.',
          'route-' || new.sunday);
      end if;
    end if;
  elsif new.status <> 'cancelled' and old.status = 'cancelled' then
    update alerts set resolved = true
     where kind = 'rider_cancel' and rider_id = new.rider_id and sunday = new.sunday and not resolved;
  end if;
  return new;
end $$;

grant select on van_shifts, home_rides to authenticated;
revoke all on van_shifts, home_rides from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function claim_push() from authenticated, public, anon;
grant execute on function claim_push() to service_role;

select 'The church van is ready. Add it in the app: Plan tab -> Church van.' as result;
