-- Update for an EXISTING Chosen Generation Rides database (26 Oct 2026):
-- notes what stops people when they fill in the sign-up form, for leaders to see on People.
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

select 'Sign-up problems will now be noted.' as result;
