-- Chosen Generation Rides: database setup for Supabase (free tier).
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- It is safe to run again later (everything is "create if not exists" or "create or replace").
--
-- THE PRIVACY MODEL (enforced here, in the database, not just in the screens):
--   * Leader: sees and edits everything.
--   * Everyone else: can read and edit ONLY their own profile, requests and availability.
--   * Nobody but the leader can read another person's row directly. A driver gets their
--     riders' pickup details, and a rider gets their driver's name and phone, only through
--     the functions below (my_route, my_rides), and only after the leader has approved the plan.
--   * Nobody can make themselves a leader, clear themselves as a driver, or edit their own
--     vetting notes (the protect_profile trigger undoes it).
--   * The plan cannot be saved with a driver the leader hasn't cleared, or more riders than seats.
--   * Vetting is the leader's job: a driver gets riders only once the leader sets them to
--     "cleared". Licence, insurance and police-check dates are optional notes for the leader.
-- Time zone: Saskatchewan is on Central Standard Time all year (America/Regina).


-- ---------------------------------------------------------------- tables

create table if not exists profiles (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid unique references auth.users (id) on delete set null,  -- null = added by the leader (phoned in)
  email              text,
  full_name          text not null,
  phone              text,
  role               text not null default 'rider' check (role in ('rider', 'driver', 'leader')),
  gender             text check (gender in ('F', 'M')),
  home_address       text,
  neighbourhood      text,                                    -- filled in from the confirmed address
  postal_code        text,
  lat                double precision,
  lng                double precision,
  -- 'verified' = confirmed on the map to the house number; the ONLY locations (with 'manual') used for matching.
  -- 'address' / 'neighbourhood' are older, unchecked lookups kept for history; they are never matched.
  geo_source         text,
  -- rider details
  minor              boolean not null default false,
  priority           boolean not null default false,          -- leader sets (e.g. seniors, no other way to church)
  weekly_checkin     boolean not null default false,          -- asks each week "Do you need a ride?"; silence = no ride
  notes              text,                                    -- e.g. "uses a walker"
  -- driver details
  seats              int not null default 0 check (seats >= 0 and seats <= 14),
  drives_every_week  boolean not null default false,
  second_trip        boolean not null default false,
  vehicle            text,
  driver_status      text not null default 'none' check (driver_status in ('none', 'pending', 'cleared', 'suspended')),
  licence_ok         boolean not null default false,
  insurance_ok       boolean not null default false,
  police_check_expiry date,
  -- text-message consent (CASL)
  texts_consent_at   timestamptz,
  texts_consent_withdrawn_at timestamptz,
  created_at         timestamptz not null default now()
);

create table if not exists consent_log (
  id          bigint generated always as identity primary key,
  profile_id  uuid not null references profiles (id) on delete cascade,
  kind        text not null check (kind in ('given', 'withdrawn')),
  wording     text,                                           -- the exact words they agreed to
  recorded_by uuid references profiles (id) on delete set null,
  at          timestamptz not null default now()
);

create table if not exists driver_weeks (
  driver_id uuid not null references profiles (id) on delete cascade,
  sunday    date not null,
  available boolean not null,
  note      text,
  primary key (driver_id, sunday)
);

create table if not exists ride_requests (
  id         uuid primary key default gen_random_uuid(),
  rider_id   uuid not null references profiles (id) on delete cascade,
  sunday     date not null,                 -- the service date (any day; normally a Sunday)
  ride_home  boolean not null default false,
  extra_people int not null default 0 check (extra_people between 0 and 10),  -- people coming with the rider; each needs a seat
  can_split  boolean not null default false,   -- OK to seat the group in different cars if no single car fits
  note       text,
  status     text not null default 'requested' check (status in ('requested', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (rider_id, sunday)
);

create table if not exists plans (
  id          uuid primary key default gen_random_uuid(),
  sunday      date not null unique,           -- the service date
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  summary     jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists assignments (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references plans (id) on delete cascade,
  rider_id      uuid not null references profiles (id) on delete cascade,
  driver_id     uuid not null references profiles (id) on delete restrict,
  trip          int not null default 1 check (trip in (1, 2)),
  stop_order    int not null default 0,
  pickup_min    int,        -- minutes after midnight
  ready_by_min  int,
  arrive_min    int,
  depart_min    int,        -- when the driver leaves home (trip 1) or church (trip 2)
  seats         int not null default 1 check (seats >= 1),   -- people in this car (rider plus anyone with them)
  unique (plan_id, rider_id, driver_id, trip)
);

create table if not exists waitlist (
  plan_id  uuid not null references plans (id) on delete cascade,
  rider_id uuid not null references profiles (id) on delete cascade,
  reason   text,
  seats    int not null default 1,   -- seats still needed
  primary key (plan_id, rider_id)
);

create table if not exists alerts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('driver_cancel', 'rider_cancel', 'info')),
  sunday     date,
  driver_id  uuid references profiles (id) on delete cascade,
  rider_id   uuid references profiles (id) on delete cascade,
  message    text not null,
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- last-minute requests (asked in the app)
-- The leader asks chosen cleared drivers to pick up someone at the last minute. Each driver sees
-- the request on their dashboard and answers Yes or No. The FIRST yes gets the ride; only that
-- driver then sees the address and phone. Drivers reach this only through the functions below.
create table if not exists help_requests (
  id            uuid primary key default gen_random_uuid(),
  sunday        date not null,
  rider_name    text not null,
  rider_phone   text,
  address       text not null,
  neighbourhood text,
  postal_code   text,
  lat           double precision,
  lng           double precision,
  seats         int not null default 1 check (seats between 1 and 10),
  pickup_min    int,
  status        text not null default 'open' check (status in ('open', 'covered', 'cancelled')),
  accepted_by   uuid references profiles (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists help_asks (
  request_id  uuid not null references help_requests (id) on delete cascade,
  driver_id   uuid not null references profiles (id) on delete cascade,
  away_min    int,
  answer      text check (answer in ('yes', 'no')),
  answered_at timestamptz,
  primary key (request_id, driver_id)
);

-- ---------------------------------------------------------------- services
-- Every Sunday is a service at 11:45 by default and needs no row here. The leader adds a row to
-- change one day (e.g. a joint service at 10:00), to mark a Sunday as having no service, or to add
-- a special service on any day (e.g. Christmas Eve at 19:00). One service per day.
create table if not exists services (
  service_date      date primary key,
  title             text,                          -- e.g. 'Joint service'; empty = 'Sunday service'
  start_time        time not null default '11:45',
  arrive_before_min int  not null default 15 check (arrive_before_min between 0 and 90),
  cutoff            timestamptz,                   -- when ride requests close; empty = noon the day before
  cancelled         boolean not null default false,
  note              text,
  updated_at        timestamptz not null default now()
);

-- Requests and plans can now be for any service day, not only Sundays.
alter table ride_requests drop constraint if exists ride_requests_sunday_check;
alter table plans drop constraint if exists plans_sunday_check;

-- ---------------------------------------------------------------- team roles
-- One SUPERVISOR (a leader who can also change who leads, and hand the role over) and at most two
-- other leaders ("Leader" and "Assistant leader"). Roles change only through set_team_role() and
-- hand_over_supervisor() below, which only the supervisor can use, and every change is logged.
alter table profiles add column if not exists is_supervisor boolean not null default false;
alter table profiles add column if not exists leader_title text;   -- 'Supervisor', 'Leader' or 'Assistant leader'
alter table profiles drop constraint if exists profiles_supervisor_is_leader;
alter table profiles add constraint profiles_supervisor_is_leader check (not is_supervisor or role = 'leader');
create unique index if not exists profiles_one_supervisor on profiles ((true)) where is_supervisor;

create table if not exists team_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid references profiles (id) on delete set null,
  actor_name  text,
  target      uuid references profiles (id) on delete set null,
  target_name text,
  change      text not null
);

-- ---------------------------------------------------------------- phone notifications (web push)
-- Each phone or computer that allows notifications saves a subscription here (one row per device).
-- Messages wait in push_queue until the "send-push" Edge Function sends them (and marks them sent).
create table if not exists push_subs (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_profile_idx on push_subs (profile_id);

create table if not exists push_queue (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references profiles (id) on delete cascade,
  title      text not null,
  body       text not null,
  tag        text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists push_queue_unsent_idx on push_queue (created_at) where sent_at is null;

-- Where a home's location came from. 'pin': the person placed a pin on their house themselves.
alter table profiles drop constraint if exists profiles_geo_source_check;
alter table profiles add constraint profiles_geo_source_check check (geo_source in ('verified', 'address', 'neighbourhood', 'manual', 'gps', 'pin', 'none'));

create index if not exists assignments_driver_idx on assignments (driver_id);
create index if not exists requests_sunday_idx on ride_requests (sunday);

-- ---------------------------------------------------------------- helpers

create or replace function today_regina() returns date
language sql stable as $$ select (now() at time zone 'America/Regina')::date $$;

-- These read profiles as the table owner, so they work inside row-level-security rules.
create or replace function is_leader() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'leader')
$$;

create or replace function my_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from profiles where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------- protect privileged columns

create or replace function protect_profile() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The SQL editor / server admin may change anything. (The team functions below run as the
  -- owner, so they pass here too; nobody else can change a team role.)
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  -- Team roles are protected from everyone, leaders included.
  if tg_op = 'INSERT' then
    new.is_supervisor := false;
    new.leader_title := null;
    if new.role = 'leader' then new.role := 'rider'; end if;
  else
    new.is_supervisor := old.is_supervisor;
    new.leader_title := old.leader_title;
    if old.role = 'leader' or new.role = 'leader' then new.role := old.role; end if;
  end if;

  -- Leaders may change everything else.
  if is_leader() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.email := coalesce(auth.jwt() ->> 'email', new.email);
    if new.role not in ('rider', 'driver') then new.role := 'rider'; end if;
    new.driver_status := case when new.role = 'driver' then 'pending' else 'none' end;
    new.priority := false;
    new.licence_ok := false;
    new.insurance_ok := false;
    new.police_check_expiry := null;
    new.texts_consent_at := null;
    new.texts_consent_withdrawn_at := null;
  else
    new.user_id := old.user_id;
    new.email := old.email;
    new.priority := old.priority;
    new.licence_ok := old.licence_ok;
    new.insurance_ok := old.insurance_ok;
    new.police_check_expiry := old.police_check_expiry;
    new.texts_consent_at := old.texts_consent_at;
    new.texts_consent_withdrawn_at := old.texts_consent_withdrawn_at;
    if new.role not in ('rider', 'driver') then new.role := old.role; end if;
    new.driver_status := old.driver_status;
    if new.role = 'driver' and old.driver_status = 'none' then new.driver_status := 'pending'; end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_trg on profiles;
create trigger protect_profile_trg before insert or update on profiles
  for each row execute function protect_profile();

-- ---------------------------------------------------------------- ride request rules

create or replace function check_request() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare closes timestamptz; svc services; special boolean;
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') or is_leader() then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.rider_id := old.rider_id;
    new.sunday := old.sunday;
    if new.status = 'cancelled' then return new; end if;   -- a rider can always say "I can't make it"
  end if;
  -- (The column is still called "sunday"; it holds the service date, which may be any day.)
  select * into svc from services where service_date = new.sunday;
  special := svc.service_date is not null;
  if special and svc.cancelled then
    raise exception 'There is no service on %. Please check the app for the next one.', to_char(new.sunday, 'FMDay, FMMonth FMDD');
  end if;
  if not special and extract(dow from new.sunday) <> 0 then
    raise exception 'There is no service on that day.';
  end if;
  if new.sunday > today_regina() + (case when special then 120 else 42 end) then
    raise exception 'That service is too far ahead to request a ride.';
  end if;
  closes := coalesce(svc.cutoff, ((new.sunday - 1)::timestamp + interval '12 hours') at time zone 'America/Regina');
  if now() >= closes then
    raise exception 'Requests for % closed on % at %. Please contact the transport leader.', to_char(new.sunday, 'FMDay, FMMonth FMDD'),
      to_char(closes at time zone 'America/Regina', 'FMDay'), to_char(closes at time zone 'America/Regina', 'FMHH12:MI AM');
  end if;
  return new;
end $$;

drop trigger if exists check_request_trg on ride_requests;
create trigger check_request_trg before insert or update on ride_requests
  for each row execute function check_request();

-- When a rider cancels, they come OUT of that Sunday's plan (seat and waiting list), and the
-- leader gets an alert naming the driver. If they ask again later, they are a NEW request: the
-- leader must approve them back in, so the driver is always told. Asking again closes the alert.
create or replace function alert_on_rider_cancel() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text; dn text; seat record;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    select x.driver_id, x.pickup_min, p.status as plan_status into seat from assignments x join plans p on p.id = x.plan_id
     where p.sunday = new.sunday and x.rider_id = new.rider_id order by x.trip limit 1;
    delete from assignments x using plans p where p.id = x.plan_id and p.sunday = new.sunday and x.rider_id = new.rider_id;
    delete from waitlist w using plans p where p.id = w.plan_id and p.sunday = new.sunday and w.rider_id = new.rider_id;
    if seat.driver_id is not null then
      select full_name into nm from profiles where id = new.rider_id;
      select full_name into dn from profiles where id = seat.driver_id;
      insert into alerts (kind, sunday, rider_id, driver_id, message)
      values ('rider_cancel', new.sunday, new.rider_id, seat.driver_id,
        nm || ' cancelled their ride for ' || to_char(new.sunday, 'FMDay, FMMonth FMDD') || '. They were in ' || dn || '''s car'
        || coalesce(' (pickup ' || to_char(time '00:00' + make_interval(mins => seat.pickup_min), 'FMHH12:MI AM') || ')', '') || '.');
      -- The driver already had this rider on their list (the plan was shared): tell them straight away.
      if seat.plan_status = 'approved' and to_regclass('public.push_queue') is not null
         and exists (select 1 from push_subs s where s.profile_id = seat.driver_id) then
        insert into push_queue (profile_id, title, body, tag)
        values (seat.driver_id, 'Change to your pickups',
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

drop trigger if exists alert_on_rider_cancel_trg on ride_requests;
create trigger alert_on_rider_cancel_trg after update on ride_requests
  for each row execute function alert_on_rider_cancel();

-- ---------------------------------------------------------------- row-level security

alter table profiles      enable row level security;
alter table consent_log   enable row level security;
alter table driver_weeks  enable row level security;
alter table ride_requests enable row level security;
alter table plans         enable row level security;
alter table assignments   enable row level security;
alter table waitlist      enable row level security;
alter table alerts        enable row level security;

drop policy if exists profiles_select on profiles;
drop policy if exists profiles_insert on profiles;
drop policy if exists profiles_update on profiles;
drop policy if exists profiles_delete on profiles;
create policy profiles_select on profiles for select using (user_id = auth.uid() or is_leader());
create policy profiles_insert on profiles for insert with check (user_id = auth.uid() or is_leader());
create policy profiles_update on profiles for update using (user_id = auth.uid() or is_leader())
                                                      with check (user_id = auth.uid() or is_leader());
create policy profiles_delete on profiles for delete using (is_leader());

drop policy if exists requests_select on ride_requests;
drop policy if exists requests_insert on ride_requests;
drop policy if exists requests_update on ride_requests;
drop policy if exists requests_delete on ride_requests;
create policy requests_select on ride_requests for select using (rider_id = my_profile_id() or is_leader());
create policy requests_insert on ride_requests for insert with check (rider_id = my_profile_id() or is_leader());
create policy requests_update on ride_requests for update using (rider_id = my_profile_id() or is_leader())
                                                       with check (rider_id = my_profile_id() or is_leader());
create policy requests_delete on ride_requests for delete using (is_leader());

drop policy if exists weeks_all on driver_weeks;
create policy weeks_all on driver_weeks for all
  using (driver_id = my_profile_id() or is_leader())
  with check (driver_id = my_profile_id() or is_leader());

alter table help_requests enable row level security;
alter table help_asks     enable row level security;
drop policy if exists help_requests_leader on help_requests;
drop policy if exists help_asks_leader on help_asks;
create policy help_requests_leader on help_requests for all using (is_leader()) with check (is_leader());
create policy help_asks_leader     on help_asks     for all using (is_leader()) with check (is_leader());

alter table services enable row level security;
drop policy if exists services_read on services;
drop policy if exists services_leader on services;
create policy services_read   on services for select using (auth.uid() is not null);
create policy services_leader on services for all using (is_leader()) with check (is_leader());

alter table team_log enable row level security;
drop policy if exists team_log_read on team_log;
create policy team_log_read on team_log for select using (is_leader());

alter table push_subs enable row level security;
alter table push_queue enable row level security;
drop policy if exists push_subs_own on push_subs;
create policy push_subs_own on push_subs for select using (profile_id in (select id from profiles where user_id = auth.uid()));
-- push_queue has no policies: only the functions below and the Edge Function (service role) use it.

-- Leader-only tables. Everyone else reaches this data only through the functions below.
drop policy if exists plans_leader on plans;
drop policy if exists assignments_leader on assignments;
drop policy if exists waitlist_leader on waitlist;
drop policy if exists alerts_leader on alerts;
drop policy if exists consent_leader on consent_log;
create policy plans_leader       on plans       for all using (is_leader()) with check (is_leader());
create policy assignments_leader on assignments for all using (is_leader()) with check (is_leader());
create policy waitlist_leader    on waitlist    for all using (is_leader()) with check (is_leader());
create policy alerts_leader      on alerts      for all using (is_leader()) with check (is_leader());
create policy consent_leader     on consent_log for select using (is_leader());

-- ---------------------------------------------------------------- functions the app calls

-- A rider's own requests, with driver details ONLY once the leader has approved the plan.
-- A group split across cars comes back as one row per car.
create or replace function my_rides()
returns table (sunday date, status text, ride_home boolean, note text, extra_people int, can_split boolean,
               driver_name text, driver_phone text, vehicle text,
               seats int, trip int, pickup_min int, ready_by_min int, arrive_min int, waitlisted_seats int)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.sunday,
         case when r.status = 'cancelled' then 'cancelled'
              when p.status = 'approved' and a.id is not null then 'seated'
              when p.status = 'approved' and w.rider_id is not null then 'waitlisted'
              else 'requested' end,
         r.ride_home, r.note, r.extra_people, r.can_split,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.full_name end,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.phone end,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.vehicle end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.seats end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.trip end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.pickup_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.ready_by_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.arrive_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then w.seats end
  from ride_requests r
  join profiles me on me.id = r.rider_id and me.user_id = auth.uid()
  left join plans p on p.sunday = r.sunday
  left join assignments a on a.plan_id = p.id and a.rider_id = r.rider_id
  left join profiles d on d.id = a.driver_id
  left join waitlist w on w.plan_id = p.id and w.rider_id = r.rider_id
  where r.sunday >= today_regina()
  order by r.sunday, a.trip, a.stop_order
$$;

-- A driver's pickup list for one Sunday: ONLY their own riders, ONLY after approval.
drop function if exists my_route(date);
create function my_route(p_sunday date)
returns table (trip int, stop_order int, pickup_min int, ready_by_min int, arrive_min int, depart_min int,
               rider_name text, rider_phone text, address text, neighbourhood text,
               lat double precision, lng double precision,
               minor boolean,
               rider_notes text, request_note text, ride_home boolean, extra_people int, seats int, party_total int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.trip, a.stop_order, a.pickup_min, a.ready_by_min, a.arrive_min, a.depart_min,
         r.full_name, r.phone, r.home_address, r.neighbourhood, r.lat, r.lng,
         r.minor,
         r.notes, q.note, coalesce(q.ride_home, false), coalesce(q.extra_people, 0), a.seats, 1 + coalesce(q.extra_people, 0)
  from assignments a
  join plans p on p.id = a.plan_id and p.status = 'approved' and p.sunday = p_sunday
  join profiles me on me.id = a.driver_id and me.user_id = auth.uid()
  join profiles r on r.id = a.rider_id
  left join ride_requests q on q.rider_id = a.rider_id and q.sunday = p.sunday
  where coalesce(q.status, 'requested') <> 'cancelled'
  order by a.trip, a.stop_order
$$;

-- A driver's last-minute requests. The address and phone appear ONLY once this driver has the ride.
drop function if exists my_help_requests();
create function my_help_requests()
returns table (id uuid, sunday date, rider_name text, neighbourhood text, seats int, pickup_min int, away_min int,
               status text, my_answer text, mine boolean, address text, rider_phone text)
language sql stable security definer set search_path = public, pg_temp as $$
  select h.id, h.sunday, split_part(h.rider_name, ' ', 1), h.neighbourhood, h.seats, h.pickup_min, k.away_min,
         h.status, k.answer, coalesce(h.accepted_by = me.id, false),
         case when h.accepted_by = me.id then h.address end,
         case when h.accepted_by = me.id then h.rider_phone end
  from help_asks k
  join help_requests h on h.id = k.request_id
  join profiles me on me.id = k.driver_id and me.user_id = auth.uid()
  where h.sunday >= today_regina() and h.status <> 'cancelled'
  order by h.created_at desc
$$;

-- A driver answers. The first yes gets the ride (the row is locked, so two yeses can't both win).
-- Returns 'accepted', 'taken' (someone else was first), 'cancelled' or 'noted' (a no).
create or replace function answer_help(p_request uuid, p_answer text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; h help_requests;
begin
  if p_answer not in ('yes', 'no') then raise exception 'Please answer yes or no.'; end if;
  select * into me from profiles where user_id = auth.uid();
  if not found or not exists (select 1 from help_asks where request_id = p_request and driver_id = me.id) then
    raise exception 'This request was not sent to you.';
  end if;
  select * into h from help_requests where id = p_request for update;
  update help_asks set answer = p_answer, answered_at = now() where request_id = p_request and driver_id = me.id;
  if p_answer = 'no' then return 'noted'; end if;
  if h.status = 'cancelled' then return 'cancelled'; end if;
  if h.status = 'covered' then return case when h.accepted_by = me.id then 'accepted' else 'taken' end; end if;
  update help_requests set status = 'covered', accepted_by = me.id, accepted_at = now() where id = p_request;
  insert into alerts (kind, sunday, driver_id, message)
  values ('info', h.sunday, me.id, me.full_name || ' said yes: they will pick up ' || h.rider_name ||
          ' on ' || to_char(h.sunday, 'FMDay, FMMonth FMDD') || '.');
  return 'accepted';
end $$;

-- "I can't make it." Marks the driver unavailable and alerts the leader. Returns riders affected.
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
  insert into alerts (kind, sunday, driver_id, message)
  values ('driver_cancel', p_sunday, me.id,
          me.full_name || ' can''t make it on ' || p_sunday || '. ' || n || ' rider(s) need a new ride.'
          || coalesce(' Note: ' || p_note, ''));
  return n;
end $$;

-- Record (or withdraw) consent to receive texts. Wording is stored with the date.
-- Leader may record it for someone who agreed by phone (pass their profile id).
create or replace function give_text_consent(p_wording text, p_profile uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; actor uuid := my_profile_id();
begin
  if p_profile is not null and p_profile <> actor then
    if not is_leader() then raise exception 'Only the leader can record consent for someone else.'; end if;
    target := p_profile;
  else
    target := actor;
  end if;
  if target is null then raise exception 'Create your profile first.'; end if;
  update profiles set texts_consent_at = now(), texts_consent_withdrawn_at = null where id = target;
  insert into consent_log (profile_id, kind, wording, recorded_by) values (target, 'given', p_wording, actor);
end $$;

create or replace function withdraw_text_consent(p_profile uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; actor uuid := my_profile_id();
begin
  if p_profile is not null and p_profile <> actor then
    if not is_leader() then raise exception 'Only the leader can do this for someone else.'; end if;
    target := p_profile;
  else
    target := actor;
  end if;
  update profiles set texts_consent_at = null, texts_consent_withdrawn_at = now() where id = target;
  insert into consent_log (profile_id, kind, recorded_by) values (target, 'withdrawn', actor);
end $$;

-- Leader saves a whole plan in one step (draft or approved). Safety rules are checked here.
-- p_assignments: [{"riderId","driverId","trip","order","pickupMin","readyByMin","arriveMin","departMin"}]
-- p_waitlist:    [{"riderId","reason"}]
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

  return pid;
end $$;

create or replace function is_supervisor() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where user_id = auth.uid() and is_supervisor and role = 'leader')
$$;

-- The supervisor makes someone Leader / Assistant leader, or moves them back to driver or rider.
-- A driver keeps their car details and checks. At most two leaders besides the supervisor.
create or replace function set_team_role(p_profile uuid, p_role text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles; n int; label text;
begin
  select * into me from profiles where user_id = auth.uid();
  if not found or not me.is_supervisor then raise exception 'Only the supervisor can change who leads.'; end if;
  if p_role not in ('leader', 'assistant', 'driver', 'rider') then raise exception 'Choose leader, assistant leader, driver or rider.'; end if;
  select * into t from profiles where id = p_profile for update;
  if not found then raise exception 'That person was not found.'; end if;
  if t.id = me.id then raise exception 'To change your own role, hand over the supervisor role first.'; end if;
  if t.user_id is null then raise exception '% has never signed in to the app, so they can''t lead yet. Ask them to sign in once first.', t.full_name; end if;
  if p_role in ('leader', 'assistant') then
    select count(*) into n from profiles where role = 'leader' and not is_supervisor and id <> t.id;
    if n >= 2 then raise exception 'There are already two leaders. Move one of them back to driver or rider first.'; end if;
    label := case when p_role = 'leader' then 'Leader' else 'Assistant leader' end;
    update profiles set role = 'leader', leader_title = label where id = t.id;
  else
    label := case when p_role = 'driver' then 'Driver' else 'Rider' end;
    update profiles set role = p_role, leader_title = null,
           driver_status = case when p_role = 'driver' and driver_status = 'none' then 'pending' else driver_status end
     where id = t.id;
  end if;
  insert into team_log (actor, actor_name, target, target_name, change)
  values (me.id, me.full_name, t.id, t.full_name, 'made ' || t.full_name || ' ' || lower(label));
  return label;
end $$;

-- The supervisor hands the role to one of the leaders, and chooses what they become themselves.
create or replace function hand_over_supervisor(p_profile uuid, p_my_role text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles; n int;
begin
  select * into me from profiles where user_id = auth.uid();
  if not found or not me.is_supervisor then raise exception 'Only the supervisor can hand over the role.'; end if;
  if p_my_role not in ('leader', 'assistant', 'driver', 'rider') then raise exception 'Choose what you will be: leader, assistant leader, driver or rider.'; end if;
  select * into t from profiles where id = p_profile for update;
  if not found or t.id = me.id then raise exception 'Choose someone else to hand over to.'; end if;
  if t.role <> 'leader' then raise exception 'Make % a leader first, then hand over.', t.full_name; end if;

  update profiles set is_supervisor = false where id = me.id;
  update profiles set is_supervisor = true, leader_title = 'Supervisor' where id = t.id;
  if p_my_role in ('leader', 'assistant') then
    select count(*) into n from profiles where role = 'leader' and not is_supervisor and id <> me.id;
    if n >= 2 then raise exception 'There are already two leaders, so you can''t stay a leader. Choose driver or rider.'; end if;
    update profiles set leader_title = case when p_my_role = 'leader' then 'Leader' else 'Assistant leader' end where id = me.id;
  else
    update profiles set role = p_my_role, leader_title = null,
           driver_status = case when p_my_role = 'driver' and driver_status = 'none' then 'pending' else driver_status end
     where id = me.id;
  end if;
  insert into team_log (actor, actor_name, target, target_name, change)
  values (me.id, me.full_name, t.id, t.full_name, 'handed the supervisor role to ' || t.full_name);
  return 'ok';
end $$;

-- ---------------------------------------------------------------- signed in, never registered
-- People who signed in with their email but never filled in their details. They have no profile,
-- so they don't show anywhere else in the app. Leaders only.
create or replace function unregistered_people()
returns table (email text, signed_up_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can see this.'; end if;
  return query
    select u.email::text, u.created_at, u.last_sign_in_at
      from auth.users u
     where not exists (select 1 from profiles p where p.user_id = u.id)
     order by u.created_at desc;
end $$;

-- ---------------------------------------------------------------- notifications
create or replace function save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid;
begin
  select id into me from profiles where user_id = auth.uid();
  if me is null then raise exception 'Finish registering first.'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' then raise exception 'That notification address is not valid.'; end if;
  insert into push_subs (profile_id, endpoint, p256dh, auth, device)
  values (me, p_endpoint, p_p256dh, p_auth, left(p_device, 200))
  on conflict (endpoint) do update set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device;
  return 'ok';
end $$;

create or replace function remove_push_sub(p_endpoint text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from push_subs where endpoint = p_endpoint and profile_id in (select id from profiles where user_id = auth.uid());
  return 'ok';
end $$;

-- A test notification to yourself, sent right after you allow notifications.
create or replace function push_test()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid; n int;
begin
  select id into me from profiles where user_id = auth.uid();
  if me is null then raise exception 'Finish registering first.'; end if;
  insert into push_queue (profile_id, title, body, tag)
  select me, 'Notifications are on ✓', 'This is a test from Chosen Generation Rides. You''ll get messages like this when your ride or route changes.', 'test'
   where exists (select 1 from push_subs s where s.profile_id = me);
  get diagnostics n = row_count;
  return n;
end $$;

-- Leaders: who has notifications turned on (just the people, not their device details).
create or replace function push_people()
returns setof uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can see this.'; end if;
  return query select distinct profile_id from push_subs;
end $$;

-- Leaders queue messages for the people in an approved plan (the app writes them).
create or replace function queue_push(p_items jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not is_leader() then raise exception 'Only leaders can send notifications.'; end if;
  insert into push_queue (profile_id, title, body, tag)
  select i.profile_id, left(i.title, 120), left(i.body, 400), left(i.tag, 60)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(profile_id uuid, title text, body text, tag text)
   where i.profile_id is not null and coalesce(i.title, '') <> '' and coalesce(i.body, '') <> ''
     and exists (select 1 from push_subs s where s.profile_id = i.profile_id);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function push_to_leaders(p_title text, p_body text, p_tag text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into push_queue (profile_id, title, body, tag)
  select p.id, p_title, left(p_body, 400), p_tag from profiles p
   where p.role = 'leader' and exists (select 1 from push_subs s where s.profile_id = p.id)
$$;

-- New alert (a cancellation, a driver who can't make it, a yes to a last-minute request) -> leaders.
create or replace function push_on_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform push_to_leaders(case new.kind when 'info' then 'Rides update' else 'Rides alert' end, new.message, 'alert');
  return new;
end $$;
drop trigger if exists push_on_alert_trg on alerts;
create trigger push_on_alert_trg after insert on alerts for each row execute function push_on_alert();

-- A last-minute request -> each driver asked.
create or replace function push_on_help_ask() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare h help_requests;
begin
  select * into h from help_requests where id = new.request_id;
  if found and exists (select 1 from push_subs s where s.profile_id = new.driver_id) then
    insert into push_queue (profile_id, title, body, tag)
    values (new.driver_id, 'Can you help with a ride?',
            split_part(h.rider_name, ' ', 1) || coalesce(' in ' || nullif(h.neighbourhood, ''), '') || ' needs a ride on '
              || trim(to_char(h.sunday, 'Day')) || '. Open the app to say yes or no.',
            'help-' || h.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_help_ask_trg on help_asks;
create trigger push_on_help_ask_trg after insert on help_asks for each row execute function push_on_help_ask();

-- A new driver waiting for approval -> leaders.
create or replace function push_on_new_driver() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.driver_status = 'pending' and (tg_op = 'INSERT' or old.driver_status is distinct from 'pending') then
    perform push_to_leaders('New driver to approve', new.full_name || ' registered as a driver. Check their details in People.', 'driver-' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_new_driver_trg on profiles;
create trigger push_on_new_driver_trg after insert or update of driver_status on profiles for each row execute function push_on_new_driver();

-- Used only by the send-push Edge Function (service role): takes the waiting messages, marks them
-- sent, and returns one row per device. Messages older than a day are dropped, not sent late.
create or replace function claim_push()
returns table (queue_id bigint, title text, body text, tag text, endpoint text, p256dh text, auth text)
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  delete from push_queue where created_at < now() - interval '30 days';
  update push_queue set sent_at = now() where sent_at is null and created_at < now() - interval '1 day';
  return query
    with c as (update push_queue q set sent_at = now() where q.sent_at is null returning q.id, q.profile_id, q.title, q.body, q.tag)
    select c.id, c.title, c.body, c.tag, s.endpoint, s.p256dh, s.auth from c join push_subs s on s.profile_id = c.profile_id;
end $$;

-- ---------------------------------------------------------------- removing a person
-- The leader can remove a rider or driver (for example a test name). Their requests, weekly
-- availability, ride assignments, waitlist entries, alerts and consent records go with them.
-- If they were in a plan, that plan goes back to draft so nobody is shown a half-empty plan.
-- Leaders cannot be removed here (use the SQL Editor), and nobody can remove themselves.
-- Their sign-in (email) is kept: if they sign in again they simply register again.

create or replace function remove_person(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare victim profiles; n_plans int; n_rides int;
begin
  if not is_leader() then raise exception 'Only the transport leader can remove people.'; end if;
  select * into victim from profiles where id = p_id;
  if not found then raise exception 'That person was not found.'; end if;
  if victim.role = 'leader' then raise exception 'Leaders cannot be removed here.'; end if;
  if victim.user_id is not null and victim.user_id = auth.uid() then raise exception 'You cannot remove yourself.'; end if;

  select count(distinct plan_id), count(*) into n_plans, n_rides
    from assignments where rider_id = p_id or driver_id = p_id;

  update plans set status = 'draft', approved_at = null
   where id in (select plan_id from assignments where rider_id = p_id or driver_id = p_id);
  delete from assignments where rider_id = p_id or driver_id = p_id;
  delete from profiles where id = p_id;

  return jsonb_build_object('removed', victim.full_name, 'plansReopened', n_plans, 'ridesRemoved', n_rides);
end $$;

-- ---------------------------------------------------------------- permissions

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------- make the first leader
-- 1) Sign in to the app once with your email (this creates your login).
-- 2) Run this in the SQL editor, with your own email and name:
--
--   insert into profiles (user_id, email, full_name, role, is_supervisor, leader_title)
--   select id, email, 'Your Name', 'leader', true, 'Supervisor' from auth.users where email = 'you@example.com'
--   on conflict (user_id) do update set role = 'leader', is_supervisor = true, leader_title = 'Supervisor';
--
-- That first person is the SUPERVISOR. From then on, leaders are added and removed in the app
-- (People tab -> Team), and the supervisor role is handed over there too. No SQL needed.
--
-- To hand over to a new leader later: do the same for them, then set your own role back to 'rider'.
-- The leader's own phone number lives on their profile; nothing in the code needs changing.

-- The Edge Function's key (service role) may use the notification tables; nobody else may claim.
grant select, insert, update, delete on push_subs, push_queue to service_role;
revoke execute on function claim_push() from authenticated, public, anon;
grant execute on function claim_push() to service_role;
