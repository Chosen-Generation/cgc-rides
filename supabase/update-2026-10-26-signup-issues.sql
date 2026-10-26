-- Update for an EXISTING Chosen Generation Rides database (26 Oct 2026):
-- 1) notes what stops people when they fill in the sign-up form, for leaders to see on People;
-- 2) leaders get a notification when a new rider registers and when someone asks for a ride.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- sign-up problems
-- When someone's sign-up form can't be saved, the message they saw is noted here (no address or
-- phone number), so leaders can see which step stops people. Leaders only can read it.
create table if not exists signup_issues (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  user_id   uuid,
  email     text,
  category  text not null,
  message   text not null,
  role      text
);
create index if not exists signup_issues_at_idx on signup_issues (at desc);

alter table signup_issues enable row level security;
drop policy if exists signup_issues_read on signup_issues;
create policy signup_issues_read on signup_issues for select using (is_leader());

-- Anyone signed in may note a problem with their own sign-up (at most 30 a day each).
create or replace function log_signup_issue(p_category text, p_message text, p_role text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from signup_issues where user_id = auth.uid() and at > now() - interval '1 day') >= 30 then return; end if;
  insert into signup_issues (user_id, email, category, message, role)
  values (auth.uid(), auth.jwt() ->> 'email', left(coalesce(p_category, 'Other'), 40), left(coalesce(p_message, ''), 300), left(p_role, 20));
  delete from signup_issues where at < now() - interval '90 days';
end $$;

grant select on signup_issues to authenticated;
revoke all on signup_issues from anon;
revoke execute on function log_signup_issue(text, text, text) from public, anon;
grant execute on function log_signup_issue(text, text, text) to authenticated;

-- A new rider registers -> leaders. (Riders a leader adds by phone have no sign-in, so they're skipped.)
create or replace function push_on_new_rider() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role = 'rider' and new.user_id is not null then
    perform push_to_leaders('New rider registered',
      new.full_name || ' signed up for rides' || coalesce(' (' || nullif(new.neighbourhood, '') || ')', '') || '. See them in People.', 'rider-' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_new_rider_trg on profiles;
create trigger push_on_new_rider_trg after insert on profiles for each row execute function push_on_new_rider();

-- Someone asks for a ride (or asks again after cancelling) -> leaders. Not when a leader adds it.
-- One notification per service day: each new one replaces the last on the phone and gives the total.
create or replace function push_on_ride_request() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text; total int; people int;
begin
  if new.status = 'requested' and (tg_op = 'INSERT' or old.status = 'cancelled') and not is_leader() then
    select full_name into nm from profiles where id = new.rider_id;
    select count(*), coalesce(sum(1 + extra_people), 0) into total, people from ride_requests where sunday = new.sunday and status = 'requested';
    perform push_to_leaders('New ride request',
      split_part(nm, ' ', 1) || case when new.extra_people > 0 then ' (+' || new.extra_people || ')' else '' end
        || ' asked for a ride for ' || to_char(new.sunday, 'FMDay, FMMonth FMDD') || '. '
        || total || case when total = 1 then ' request' else ' requests' end || ' (' || people || case when people = 1 then ' seat' else ' seats' end || ') so far.',
      'requests-' || new.sunday);
  end if;
  return new;
end $$;
drop trigger if exists push_on_ride_request_trg on ride_requests;
create trigger push_on_ride_request_trg after insert or update of status on ride_requests for each row execute function push_on_ride_request();

select 'Done: sign-up problems noted; leaders told about new riders and ride requests.' as result;
