-- Update for an EXISTING Chosen Generation Rides database (26 Oct 2026, afternoon):
-- a driver gets a notification when a leader approves them.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- A leader approves a driver (status becomes cleared) -> that driver.
create or replace function push_on_driver_cleared() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.driver_status = 'cleared' and old.driver_status is distinct from 'cleared' and new.role = 'driver'
     and exists (select 1 from push_subs s where s.profile_id = new.id) then
    insert into push_queue (profile_id, title, body, tag)
    values (new.id, 'You''re approved to drive ✓',
      'Thank you, ' || split_part(new.full_name, ' ', 1) || '! You can now be given riders. Open the app to choose the Sundays you can drive.', 'driver-' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_driver_cleared_trg on profiles;
create trigger push_on_driver_cleared_trg after update of driver_status on profiles for each row execute function push_on_driver_cleared();

select 'Drivers will now be told when they are approved.' as result;
