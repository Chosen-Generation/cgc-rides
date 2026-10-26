-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, evening):
-- 1) remembers whether a home was located with the phone ('gps') or by a pin placed by hand ('pin');
-- 2) when a rider cancels from a shared plan, their driver gets a phone notification straight away;
-- 3) a test notification right after someone allows notifications.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

alter table profiles drop constraint if exists profiles_geo_source_check;
alter table profiles add constraint profiles_geo_source_check check (geo_source in ('verified', 'address', 'neighbourhood', 'manual', 'gps', 'pin', 'none'));

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

revoke execute on function push_test() from public, anon;
grant execute on function push_test() to authenticated;

select 'Done: phone locations, drivers told when a rider cancels, test notifications.' as result;
