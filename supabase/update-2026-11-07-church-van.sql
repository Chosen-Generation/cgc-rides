-- Update for an EXISTING Chosen Generation Rides database (7 Nov 2026): the church van.
-- 1) The van is a vehicle in the plan (up to 14 passengers). On days a leader chooses a van driver,
--    the planner uses it first; the driver starts from the church or from their home.
-- 2) The van logbook: before/after checks (km, fuel, receipt, damage) by whoever drives it.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- church van
-- The van is a "vehicle" profile (not a person): it never signs in, is always cleared, and is
-- parked at the church. It's used only on days a leader chooses who drives it (van_shifts); that
-- person's own car isn't used that day. They start from the church, or from their home if they
-- took the van home the night before.
alter table profiles add column if not exists is_vehicle boolean not null default false;
create unique index if not exists profiles_one_van on profiles ((true)) where is_vehicle;

create table if not exists van_shifts (
  sunday     date primary key,                                   -- the service date
  driver_id  uuid references profiles (id) on delete set null,    -- who drives the van that day
  start_from text not null default 'church' check (start_from in ('church', 'home')),
  updated_at timestamptz not null default now()
);

-- The van logbook: the van driver fills in a short check before driving and after parking.
-- Kilometres, fuel and any damage are recorded with who drove and when, so a problem can be
-- traced to when it first appeared (protecting whoever drove it properly).
create table if not exists van_logs (
  id              uuid primary key default gen_random_uuid(),
  sunday          date not null,
  driver_id       uuid references profiles (id) on delete set null,
  driver_name     text,                                 -- kept even if the person is removed later
  -- before driving
  before_at       timestamptz not null default now(),
  start_km        int not null check (start_km >= 0),
  fuel_start      text check (fuel_start in ('full', '3/4', '1/2', '1/4', 'low')),
  checks          jsonb not null default '{}'::jsonb,   -- e.g. {"tires":true,"lights":true,...}
  damage_before   boolean not null default false,
  damage_before_note text,
  -- after parking
  after_at        timestamptz,
  end_km          int check (end_km >= 0),
  fuel_end        text check (fuel_end in ('full', '3/4', '1/2', '1/4', 'low')),
  fuel_bought     boolean not null default false,
  fuel_litres     numeric(6,2),
  fuel_cost       numeric(8,2),
  receipt_given   boolean not null default false,      -- receipt handed to the church secretary
  damage_after    boolean not null default false,
  damage_after_note text,
  notes           text
);
create index if not exists van_logs_before_idx on van_logs (before_at desc);

alter table alerts drop constraint if exists alerts_kind_check;
alter table alerts add constraint alerts_kind_check check (kind in ('driver_cancel', 'rider_cancel', 'info', 'van'));

alter table van_shifts enable row level security;
drop policy if exists van_shifts_leader on van_shifts;
create policy van_shifts_leader on van_shifts for select using (is_leader());
alter table van_logs enable row level security;
drop policy if exists van_logs_leader on van_logs;
create policy van_logs_leader on van_logs for select using (is_leader());

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

-- Leaders: who drives the van on a service day (null = the van isn't used), and where they start:
-- 'church' (pick the van up at church) or 'home' (they took it home the night before).
drop function if exists set_van_driver(date, uuid, int);
create or replace function set_van_driver(p_sunday date, p_driver uuid, p_start_from text default 'church')
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can choose the van driver.'; end if;
  if p_driver is null then
    delete from van_shifts where sunday = p_sunday;
    return 'ok';
  end if;
  if not exists (select 1 from profiles where id = p_driver and not is_vehicle and driver_status = 'cleared' and role in ('driver', 'leader')) then
    raise exception 'Only a cleared driver can drive the church van.';
  end if;
  if coalesce(p_start_from, 'church') not in ('church', 'home') then raise exception 'Start from the church or from home.'; end if;
  insert into van_shifts (sunday, driver_id, start_from) values (p_sunday, p_driver, coalesce(p_start_from, 'church'))
  on conflict (sunday) do update set driver_id = excluded.driver_id, start_from = excluded.start_from, updated_at = now();
  return 'ok';
end $$;

-- Before driving. Only the person chosen to drive the van that day (or a leader).
-- Flags damage they find (with who drove it last) and kilometres nobody logged.
create or replace function van_log_start(p_sunday date, p_start_km int, p_fuel text, p_checks jsonb,
                                         p_damage boolean default false, p_damage_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; prev van_logs; lid uuid;
begin
  select * into me from profiles where user_id = auth.uid();
  if not found then raise exception 'Sign in first.'; end if;
  if not is_leader() and not exists (select 1 from van_shifts where sunday = p_sunday and driver_id = me.id) then
    raise exception 'Only the person driving the church van that day can fill in its log.';
  end if;
  if p_start_km is null or p_start_km < 0 then raise exception 'Enter the kilometres shown on the van before you drive.'; end if;
  if exists (select 1 from van_logs where sunday = p_sunday and driver_id = me.id and after_at is null) then
    raise exception 'You already started the van log for this day. Fill in the "after" part when you park.';
  end if;
  if p_damage and coalesce(trim(p_damage_note), '') = '' then raise exception 'Describe the damage you noticed (where and what).'; end if;
  select * into prev from van_logs where end_km is not null order by after_at desc limit 1;

  insert into van_logs (sunday, driver_id, driver_name, start_km, fuel_start, checks, damage_before, damage_before_note)
  values (p_sunday, me.id, me.full_name, p_start_km, p_fuel, coalesce(p_checks, '{}'::jsonb), coalesce(p_damage, false), nullif(trim(p_damage_note), ''))
  returning id into lid;

  if coalesce(p_damage, false) then
    insert into alerts (kind, sunday, driver_id, message)
    values ('van', p_sunday, me.id, me.full_name || ' noticed damage on the church van BEFORE driving: ' || trim(p_damage_note) || '.'
      || case when prev.id is not null then ' It was last driven by ' || coalesce(prev.driver_name, 'someone') || ' on '
           || to_char(prev.sunday, 'FMMonth FMDD') || ' (ended at ' || prev.end_km || ' km)' || case when prev.damage_after then ', who reported damage too' else ', who reported no damage' end || '.'
         else ' There is no earlier trip in the log.' end);
  end if;
  if prev.id is not null and p_start_km <> prev.end_km then
    insert into alerts (kind, sunday, driver_id, message)
    values ('van', p_sunday, me.id, 'Church van kilometres don''t match: ' || me.full_name || ' started at ' || p_start_km || ' km, but the last trip ('
      || coalesce(prev.driver_name, 'someone') || ', ' || to_char(prev.sunday, 'FMMonth FMDD') || ') ended at ' || prev.end_km || ' km. '
      || case when p_start_km > prev.end_km then (p_start_km - prev.end_km) || ' km were driven without a log entry.' else 'Check the numbers with both drivers.' end);
  end if;
  return lid;
end $$;

-- After parking: kilometres, fuel, receipt and any new damage.
create or replace function van_log_end(p_log uuid, p_end_km int, p_fuel text, p_fuel_bought boolean default false,
                                       p_litres numeric default null, p_cost numeric default null, p_receipt_given boolean default false,
                                       p_damage boolean default false, p_damage_note text default null, p_notes text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; l van_logs;
begin
  select * into me from profiles where user_id = auth.uid();
  select * into l from van_logs where id = p_log for update;
  if not found then raise exception 'That van log was not found.'; end if;
  if l.driver_id is distinct from me.id and not is_leader() then raise exception 'Only the person who started this log can finish it.'; end if;
  if l.after_at is not null and not is_leader() then raise exception 'This trip is already logged.'; end if;
  if p_end_km is null or p_end_km < l.start_km then raise exception 'The kilometres at the end can''t be less than at the start (%).', l.start_km; end if;
  if p_end_km - l.start_km > 1000 then raise exception 'That is over 1000 km for one day. Check the number.'; end if;
  if coalesce(p_fuel_bought, false) and (p_cost is null or p_cost <= 0) then raise exception 'Enter how much the fuel cost.'; end if;
  if p_damage and coalesce(trim(p_damage_note), '') = '' then raise exception 'Describe the damage (where and what happened).'; end if;
  update van_logs set after_at = now(), end_km = p_end_km, fuel_end = p_fuel, fuel_bought = coalesce(p_fuel_bought, false),
         fuel_litres = case when p_fuel_bought then p_litres end, fuel_cost = case when p_fuel_bought then p_cost end,
         receipt_given = coalesce(p_receipt_given, false), damage_after = coalesce(p_damage, false),
         damage_after_note = nullif(trim(p_damage_note), ''), notes = nullif(trim(p_notes), '')
   where id = p_log;
  if coalesce(p_damage, false) then
    insert into alerts (kind, sunday, driver_id, message)
    values ('van', l.sunday, l.driver_id, coalesce(l.driver_name, 'The driver') || ' reported damage to the church van after driving: ' || trim(p_damage_note) || '.');
  end if;
  if coalesce(p_fuel_bought, false) and not coalesce(p_receipt_given, false) then
    insert into alerts (kind, sunday, driver_id, message)
    values ('van', l.sunday, l.driver_id, coalesce(l.driver_name, 'The driver') || ' bought fuel for the church van ($' || to_char(p_cost, 'FM9990.00')
      || ') and still has to give the receipt to the secretary.');
  end if;
  return 'ok';
end $$;

-- Mark the fuel receipt as given to the secretary (the driver later, or a leader).
create or replace function van_log_receipt(p_log uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update van_logs set receipt_given = true
   where id = p_log and (is_leader() or driver_id = (select id from profiles where user_id = auth.uid()));
  if not found then raise exception 'That van log was not found.'; end if;
  return 'ok';
end $$;

-- The van driver's log for a day, plus how the last trip ended (so they can compare).
create or replace function my_van_log(p_sunday date)
returns table (id uuid, start_km int, fuel_start text, damage_before boolean, before_at timestamptz,
               end_km int, fuel_end text, fuel_bought boolean, fuel_cost numeric, receipt_given boolean, after_at timestamptz,
               last_driver text, last_end_km int, last_sunday date, last_damage boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (select id from profiles where user_id = auth.uid()),
       mine as (select l.* from van_logs l, me where l.sunday = p_sunday and l.driver_id = me.id order by l.before_at desc limit 1),
       prev as (select l.* from van_logs l where l.end_km is not null and l.id not in (select id from mine) order by l.after_at desc limit 1)
  select m.id, m.start_km, m.fuel_start, m.damage_before, m.before_at, m.end_km, m.fuel_end, m.fuel_bought, m.fuel_cost, m.receipt_given, m.after_at,
         p.driver_name, p.end_km, p.sunday, p.damage_after
  from (select 1) one
  left join mine m on true
  left join prev p on true
  where exists (select 1 from van_shifts s, me where s.sunday = p_sunday and s.driver_id = me.id)
     or exists (select 1 from mine)
$$;

-- A rider's own rides. For the church van, the "driver" is whoever drives the van that day.
drop function if exists my_rides();
create function my_rides()
returns table (sunday date, status text, ride_home boolean, note text, extra_people int, can_split boolean,
               driver_name text, driver_phone text, vehicle text,
               seats int, trip int, pickup_min int, ready_by_min int, arrive_min int, waitlisted_seats int,
               in_van boolean)
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
         coalesce(d.is_vehicle, false)
  from ride_requests r
  join profiles me on me.id = r.rider_id and me.user_id = auth.uid()
  left join plans p on p.sunday = r.sunday
  left join assignments a on a.plan_id = p.id and a.rider_id = r.rider_id
  left join profiles d on d.id = a.driver_id
  left join van_shifts s on s.sunday = r.sunday
  left join profiles vd on d.is_vehicle and vd.id = s.driver_id
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
               in_van boolean, van_start text)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.trip, a.stop_order, a.pickup_min, a.ready_by_min, a.arrive_min, a.depart_min,
         r.full_name, r.phone, r.home_address, r.neighbourhood, r.lat, r.lng,
         r.minor,
         r.notes, q.note, coalesce(q.ride_home, false), coalesce(q.extra_people, 0), a.seats, 1 + coalesce(q.extra_people, 0),
         d.is_vehicle, case when d.is_vehicle then s.start_from end
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

create or replace function push_on_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform push_to_leaders(case new.kind when 'info' then 'Rides update' when 'van' then 'Church van' else 'Rides alert' end, new.message, 'alert');
  return new;
end $$;

grant select on van_shifts, van_logs to authenticated;
revoke all on van_shifts, van_logs from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function claim_push() from authenticated, public, anon;
grant execute on function claim_push() to service_role;

select 'The church van and its logbook are ready. Add the van in the app: Plan tab -> Church van.' as result;
