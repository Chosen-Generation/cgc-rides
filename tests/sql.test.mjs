import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Runs supabase/schema.sql in a real in-memory Postgres (PGlite) with Supabase's auth stubbed,
// then checks the privacy and safety rules by acting as different signed-in users.
// It proves the rules in the SQL work; it does not test Supabase's hosted login itself.

const db = new PGlite();
const U = {
  leader: "00000000-0000-0000-0000-00000000000a",
  d1: "00000000-0000-0000-0000-0000000000d1",
  d2: "00000000-0000-0000-0000-0000000000d2",
  r1: "00000000-0000-0000-0000-0000000000f1",
  r2: "00000000-0000-0000-0000-0000000000f2",
};
const P = {}; // profile ids by key

async function as(key, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${U[key]}',false), set_config('request.jwt.claim.email','${key}@example.com',false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;

function sundayInDays(minDays) {
  const d = new Date(Date.now() + minDays * 86400000);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const SUN = sundayInDays(14);
const PAST = "2020-01-05"; // a Sunday long ago
const FAR = sundayInDays(90);

before(async () => {
  await db.exec(readFileSync(new URL("./sql-stubs.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
  for (const [k, id] of Object.entries(U)) await db.query("insert into auth.users (id,email) values ($1,$2)", [id, `${k}@example.com`]);
  // The leader is created the way the README says: from the SQL editor.
  await db.exec(`insert into profiles (user_id,email,full_name,role) select id,email,'Leader','leader' from auth.users where email='leader@example.com'`);
  P.leader = (await q("select id from profiles where user_id=$1", [U.leader]))[0].id;
});

test("schema can be run twice without errors", async () => {
  await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
});

test("a new user cannot make themselves leader or clear themselves as a driver", async () => {
  await as("d1", async () => {
    await db.query("insert into profiles (user_id,full_name,role,driver_status,licence_ok,insurance_ok,police_check_expiry,priority,seats,vehicle) values ($1,'Dee One','leader','cleared',true,true,'2030-01-01',true,3,'Blue van')", [U.d1]);
  });
  const [p] = await q("select * from profiles where user_id=$1", [U.d1]);
  P.d1 = p.id;
  assert.equal(p.role, "rider");
  assert.equal(p.driver_status, "none");
  assert.equal(p.licence_ok, false);
  assert.equal(p.priority, false);
  assert.equal(p.police_check_expiry, null);
  assert.equal(p.email, "d1@example.com");

  // Applying to drive makes them pending, still not cleared.
  await as("d1", () => db.query("update profiles set role='driver', driver_status='cleared', licence_ok=true where user_id=$1", [U.d1]));
  const [p2] = await q("select role,driver_status,licence_ok from profiles where id=$1", [P.d1]);
  assert.deepEqual({ ...p2 }, { role: "driver", driver_status: "pending", licence_ok: false });
});

test("setup: more people register; leader clears driver 1", async () => {
  await as("d2", () => db.query("insert into profiles (user_id,full_name,role,seats) values ($1,'Dee Two','driver',2)", [U.d2]));
  await as("r1", () => db.query("insert into profiles (user_id,full_name,phone,home_address,neighbourhood,lat,lng,gender) values ($1,'Rita One','306-555-0101','12 Secret St','Evergreen',52.17,-106.6,'F')", [U.r1]));
  await as("r2", () => db.query("insert into profiles (user_id,full_name,phone,home_address,minor) values ($1,'Ray Two','306-555-0102','99 Other Ave',true)", [U.r2]));
  for (const k of ["d2", "r1", "r2"]) P[k] = (await q("select id from profiles where user_id=$1", [U[k]]))[0].id;
  await as("leader", () => db.query("update profiles set driver_status='cleared', licence_ok=true, insurance_ok=true, police_check_expiry='2030-01-01', seats=3 where id=$1", [P.d1]));
  assert.equal((await q("select driver_status from profiles where id=$1", [P.d1]))[0].driver_status, "cleared");
});

test("people can read only their own profile; anonymous visitors get nothing", async () => {
  assert.equal((await as("r1", () => q("select id from profiles"))).length, 1);
  assert.equal((await as("d1", () => q("select id from profiles"))).length, 1);
  assert.equal((await as("leader", () => q("select id from profiles"))).length, 5);
  await db.exec("set role anon");
  await assert.rejects(() => db.query("select * from profiles"), /permission denied/);
  await db.exec("reset role");
});

test("riders can request an upcoming Sunday but not a past or far-off one", async () => {
  await as("r1", () => db.query("insert into ride_requests (rider_id,sunday,ride_home) values ($1,$2,true)", [P.r1, SUN]));
  await as("r2", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r2, SUN]));
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r1, PAST])), /closed/);
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r1, FAR])), /too far/);
  // and cannot request on someone else's behalf
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r2, sundayInDays(21)])), /row-level security/);
});

test("the plan cannot be saved with an uncleared driver or too many riders", async () => {
  const a = (r, d, extra = {}) => ({ riderId: P[r], driverId: P[d], trip: 1, order: 0, pickupMin: 620, readyByMin: 615, arriveMin: 690, ...extra });
  await assert.rejects(() => as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", "d2")])])), /cleared drivers/);
  await db.exec("update profiles set seats=1 where id='" + P.d1 + "'");
  await assert.rejects(() => as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", "d1"), a("r2", "d1", { order: 1 })])])), /more people than seats/);
  await db.exec("update profiles set seats=3 where id='" + P.d1 + "'");
  await assert.rejects(() => as("r1", () => db.query("select save_plan($1,'draft','{}','[]','[]')", [SUN])), /Only the transport leader/);
  // nothing was left half-saved by the failed attempts
  assert.equal((await q("select count(*)::int c from assignments"))[0].c, 0);
});

test("before approval nobody but the leader sees any match", async () => {
  const a = (r, order) => ({ riderId: P[r], driverId: P.d1, trip: 1, order, pickupMin: 620 + order * 10, readyByMin: 615, arriveMin: 690 });
  await as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", 0), a("r2", 1)])]));
  assert.equal((await as("d1", () => q("select * from my_route($1)", [SUN]))).length, 0);
  const mine = await as("r1", () => q("select * from my_rides()"));
  assert.equal(mine[0].status, "requested");
  assert.equal(mine[0].driver_name, null);
});

test("after approval the driver sees their riders' details and the rider sees the driver", async () => {
  await db.exec("update profiles set phone='306-555-0150' where id='" + P.d1 + "'");
  const asg = (r, order) => ({ riderId: P[r], driverId: P.d1, trip: 1, order, pickupMin: 620 + order * 10, readyByMin: 615, arriveMin: 690 });
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg("r1", 0), asg("r2", 1)])]));

  const route = await as("d1", () => q("select * from my_route($1)", [SUN]));
  assert.equal(route.length, 2);
  assert.equal(route[0].rider_name, "Rita One");
  assert.equal(route[0].address, "12 Secret St");
  assert.equal(route[0].ride_home, true);
  assert.equal(route[1].minor, true);

  // A different driver sees none of them.
  assert.equal((await as("d2", () => q("select * from my_route($1)", [SUN]))).length, 0);
  // Drivers still can't read rider profiles directly.
  assert.equal((await as("d1", () => q("select id from profiles where id=$1", [P.r1]))).length, 0);

  const mine = await as("r1", () => q("select * from my_rides()"));
  assert.equal(mine[0].status, "seated");
  assert.equal(mine[0].driver_name, "Dee One");
  assert.equal(mine[0].driver_phone, "306-555-0150");
  assert.equal(mine[0].vehicle, "Blue van");
  assert.equal(mine[0].pickup_min, 620);
  // The rider can't read the driver's profile (home address) directly.
  assert.equal((await as("r1", () => q("select id from profiles where id=$1", [P.d1]))).length, 0);
  // Other riders can't see someone else's plan.
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,$3)", [SUN, JSON.stringify([asg("r1", 0)]), JSON.stringify([{ riderId: P.r2, reason: "Seats full" }])]));
  const r2 = await as("r2", () => q("select * from my_rides()"));
  assert.equal(r2[0].status, "waitlisted");
  assert.equal(r2[0].driver_name, null);
  assert.equal((await as("r1", () => q("select * from plans"))).length, 0);
  assert.equal((await as("r1", () => q("select * from assignments"))).length, 0);
  assert.equal((await as("r1", () => q("select * from waitlist"))).length, 0);
});

test("a driver's 'I can't make it' marks them unavailable and alerts the leader", async () => {
  const n = await as("d1", () => q("select driver_cant_make_it($1,'Sick') as n", [SUN]));
  assert.equal(n[0].n, 1);
  const wk = await q("select available from driver_weeks where driver_id=$1 and sunday=$2", [P.d1, SUN]);
  assert.equal(wk[0].available, false);
  const alerts = await as("leader", () => q("select * from alerts where kind='driver_cancel'"));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Dee One/);
  assert.equal((await as("r1", () => q("select * from alerts"))).length, 0);
  await assert.rejects(() => as("r1", () => q("select driver_cant_make_it($1)", [SUN])), /Only drivers/);
});

test("a rider with a seat who cancels alerts the leader", async () => {
  await as("r1", () => db.query("update ride_requests set status='cancelled' where rider_id=$1 and sunday=$2", [P.r1, SUN]));
  const alerts = await as("leader", () => q("select * from alerts where kind='rider_cancel'"));
  assert.equal(alerts.length, 1);
  const mine = await as("r1", () => q("select status, driver_name from my_rides()"));
  assert.equal(mine[0].status, "cancelled");
  assert.equal(mine[0].driver_name, null);
});

test("text consent is recorded with a date and wording, and can't be faked by editing the profile", async () => {
  await as("r2", () => db.query("update profiles set texts_consent_at=now() where id=$1", [P.r2]));
  assert.equal((await q("select texts_consent_at from profiles where id=$1", [P.r2]))[0].texts_consent_at, null);
  await as("r2", () => db.query("select give_text_consent('I agree to receive ride texts from Chosen Generation Church.')"));
  const [p] = await q("select texts_consent_at from profiles where id=$1", [P.r2]);
  assert.ok(p.texts_consent_at);
  const log = await as("leader", () => q("select * from consent_log where profile_id=$1", [P.r2]));
  assert.equal(log.length, 1);
  assert.match(log[0].wording, /agree/);
  await assert.rejects(() => as("r1", () => q("select give_text_consent('x',$1)", [P.r2])), /Only the leader/);
  await as("r2", () => db.query("select withdraw_text_consent()"));
  assert.ok((await q("select texts_consent_withdrawn_at from profiles where id=$1", [P.r2]))[0].texts_consent_withdrawn_at);
});

test("the leader can add a rider who phoned in", async () => {
  await as("leader", async () => {
    const [{ id }] = await q("insert into profiles (full_name,phone,home_address,role) values ('Mrs Phoned In','306-555-0110','5 Elm St','rider') returning id");
    await db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [id, SUN]);
  });
  assert.equal((await q("select count(*)::int c from profiles where user_id is null"))[0].c, 1);
});

test("seats are counted by people: a split group shows one row per car; a car can't be over-filled by people", async () => {
  await db.exec("update profiles set seats=4 where id='" + P.d1 + "'");
  await db.exec("update profiles set driver_status='cleared' where id='" + P.d2 + "'");
  await db.exec("update profiles set seats=3 where id='" + P.d2 + "'");
  await db.query("update ride_requests set status='requested', extra_people=5, can_split=true where rider_id=$1 and sunday=$2", [P.r1, SUN]);
  const asg = (d, seats, order = 0) => ({ riderId: P.r1, driverId: P.d1 === d ? P.d1 : P.d2, trip: 1, order, seats, pickupMin: 620, readyByMin: 615, arriveMin: 690 });
  // 5 people in a 4-seat car: refused
  await assert.rejects(() => as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg(P.d1, 5)])])), /more people than seats/);
  // 4 + 2 across two cars, no one waiting: accepted
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg(P.d1, 4), asg(P.d2, 2)])]));
  const rows = await as("r1", () => q("select driver_name, seats from my_rides() where sunday=$1 order by seats desc", [SUN]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.seats), [4, 2]);
  // Each driver sees only their share, and the whole party size.
  const route = await as("d2", () => q("select seats, party_total, extra_people from my_route($1)", [SUN]));
  assert.deepEqual({ ...route[0] }, { seats: 2, party_total: 6, extra_people: 5 });
  // A leftover waitlist share is visible to the rider as "still waiting for N".
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,$3)", [SUN, JSON.stringify([asg(P.d1, 4)]), JSON.stringify([{ riderId: P.r1, reason: "No seats", seats: 2 }])]));
  const left = await as("r1", () => q("select waitlisted_seats from my_rides() where sunday=$1", [SUN]));
  assert.equal(left[0].waitlisted_seats, 2);
});

test("a leader who also drives can be given riders, sees their route, and can say they can't make it", async () => {
  await db.exec("update profiles set seats=3, driver_status='cleared' where id='" + P.leader + "'");
  await db.query("update ride_requests set status='requested', extra_people=0 where rider_id=$1 and sunday=$2", [P.r1, SUN]);
  const asg = { riderId: P.r1, driverId: P.leader, trip: 1, order: 0, seats: 1, pickupMin: 620, readyByMin: 615, arriveMin: 690 };
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg])]));
  const route = await as("leader", () => q("select rider_name from my_route($1)", [SUN]));
  assert.equal(route.length, 1);
  const n = await as("leader", () => q("select driver_cant_make_it($1,'Away') as n", [SUN]));
  assert.equal(n[0].n, 1);
});

test("the leader can remove a test person; their rides go and the plan goes back to draft", async () => {
  const asg = (riderId, driverId, order = 0) => ({ riderId, driverId, trip: 1, order, seats: 1, pickupMin: 620, readyByMin: 615, arriveMin: 690 });
  // a rider is removed
  await db.query("update ride_requests set status='requested', extra_people=0 where rider_id=$1 and sunday=$2", [P.r2, SUN]);
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg(P.r2, P.d1)])]));
  const out = await as("leader", () => q("select remove_person($1) as r", [P.r2]));
  assert.equal(out[0].r.plansReopened, 1);
  assert.equal((await q("select count(*)::int c from profiles where id=$1", [P.r2]))[0].c, 0);
  assert.equal((await q("select count(*)::int c from ride_requests where rider_id=$1", [P.r2]))[0].c, 0);
  assert.equal((await q("select status from plans where sunday=$1", [SUN]))[0].status, "draft");
  assert.equal((await q("select count(*)::int c from assignments a join plans p on p.id=a.plan_id where p.sunday=$1", [SUN]))[0].c, 0);
  // a driver who has riders in a plan is removed
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg(P.r1, P.d1)])]));
  await as("leader", () => db.query("select remove_person($1)", [P.d1]));
  assert.equal((await q("select count(*)::int c from profiles where id=$1", [P.d1]))[0].c, 0);
  assert.equal((await q("select status from plans where sunday=$1", [SUN]))[0].status, "draft");
  // the rider who was in that car is still there
  assert.equal((await q("select count(*)::int c from profiles where id=$1", [P.r1]))[0].c, 1);
  // the sign-in itself is kept so they can register again
  assert.equal((await q("select count(*)::int c from auth.users where id=$1", [U.d1]))[0].c, 1);
});

test("only the leader can remove people, and leaders cannot be removed", async () => {
  await assert.rejects(() => as("r1", () => db.query("select remove_person($1)", [P.leader])), /Only the transport leader/);
  await assert.rejects(() => as("leader", () => db.query("select remove_person($1)", [P.leader])), /Leaders cannot be removed/);
  await assert.rejects(() => as("leader", () => db.query("select remove_person($1)", ["00000000-0000-0000-0000-000000000999"])), /not found/);
});

test("last-minute request: drivers asked see it, first yes wins, only the winner sees the address", async () => {
  // Two cleared drivers of its own (earlier tests remove people).
  Object.assign(U, { h1: "00000000-0000-0000-0000-0000000000a1", h2: "00000000-0000-0000-0000-0000000000a2" });
  for (const k of ["h1", "h2"]) {
    await db.query("insert into auth.users (id,email) values ($1,$2)", [U[k], `${k}@example.com`]);
    await db.query("insert into profiles (user_id,email,full_name,role,driver_status,seats) values ($1,$2,$3,'driver','cleared',3)", [U[k], `${k}@example.com`, `Helper ${k}`]);
  }
  const [h1, h2] = [(await q("select id from profiles where user_id=$1", [U.h1]))[0].id, (await q("select id from profiles where user_id=$1", [U.h2]))[0].id];
  const P2 = { d1: h1, d2: h2 };
  const [{ id: req }] = await as("leader", () => q(
    "insert into help_requests (sunday,rider_name,rider_phone,address,neighbourhood,lat,lng,seats,pickup_min) values ($1,'Stephan Lee','306-555-0199','238 Fairmont Drive','Fairhaven',52.12,-106.73,1,670) returning id", [SUN]));
  await as("leader", () => db.query("insert into help_asks (request_id,driver_id,away_min) values ($1,$2,13),($1,$3,17)", [req, P2.d1, P2.d2]));

  // Drivers can't read the tables directly, only through my_help_requests().
  assert.equal((await as("h1", () => q("select * from help_requests"))).length, 0);
  const before = await as("h1", () => q("select * from my_help_requests()"));
  assert.equal(before.length, 1);
  assert.equal(before[0].rider_name, "Stephan");
  assert.equal(before[0].address, null, "no address before saying yes");
  assert.equal((await as("r1", () => q("select * from my_help_requests()"))).length, 0, "riders see nothing");

  assert.equal((await as("h1", () => q("select answer_help($1,'yes') r", [req])))[0].r, "accepted");
  assert.equal((await as("h2", () => q("select answer_help($1,'yes') r", [req])))[0].r, "taken");
  const d1 = (await as("h1", () => q("select * from my_help_requests()")))[0];
  const d2 = (await as("h2", () => q("select * from my_help_requests()")))[0];
  assert.equal(d1.address, "238 Fairmont Drive");
  assert.equal(d1.rider_phone, "306-555-0199");
  assert.equal(d1.mine, true);
  assert.equal(d2.address, null, "the second driver never sees the address");
  assert.equal(d2.status, "covered");
  assert.equal((await q("select accepted_by from help_requests where id=$1", [req]))[0].accepted_by, P2.d1);
  assert.equal((await q("select count(*)::int n from alerts where kind='info' and driver_id=$1", [P2.d1]))[0].n, 1);

  // Someone who wasn't asked can't answer.
  await assert.rejects(() => as("r1", () => q("select answer_help($1,'yes')", [req])), /not sent to you/);
});

test("a rider who cancels leaves the plan; asking again needs the leader's approval", async () => {
  Object.assign(U, { c1: "00000000-0000-0000-0000-0000000000c1", c2: "00000000-0000-0000-0000-0000000000c2" });
  await db.query("insert into auth.users (id,email) values ($1,'c1@example.com'),($2,'c2@example.com')", [U.c1, U.c2]);
  await db.query("insert into profiles (user_id,full_name,role,driver_status,seats) values ($1,'Dami Driver','driver','cleared',3)", [U.c1]);
  await db.query("insert into profiles (user_id,full_name,role) values ($1,'Jo Rider','rider')", [U.c2]);
  const dami = (await q("select id from profiles where user_id=$1", [U.c1]))[0].id;
  const jo = (await q("select id from profiles where user_id=$1", [U.c2]))[0].id;
  const S2 = sundayInDays(21);
  await as("c2", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [jo, S2]));
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [S2, JSON.stringify([{ riderId: jo, driverId: dami, trip: 1, order: 0, pickupMin: 665, readyByMin: 660, arriveMin: 690, departMin: 650 }])]));
  assert.equal((await as("c2", () => q("select status from my_rides() where sunday=$1", [S2])))[0].status, "seated");

  await as("c2", () => db.query("update ride_requests set status='cancelled' where rider_id=$1 and sunday=$2", [jo, S2]));
  assert.equal((await q("select count(*)::int n from assignments a join plans p on p.id=a.plan_id where p.sunday=$1", [S2]))[0].n, 0, "seat removed");
  const [al] = await q("select * from alerts where kind='rider_cancel' and rider_id=$1", [jo]);
  assert.equal(al.driver_id, dami);
  assert.match(al.message, /Jo Rider cancelled their ride for .* They were in Dami Driver's car \(pickup 11:05 AM\)\./);

  // Asks again: NOT seated until the leader approves again; the cancel alert closes.
  await as("c2", () => db.query("update ride_requests set status='requested' where rider_id=$1 and sunday=$2", [jo, S2]));
  assert.equal((await as("c2", () => q("select status from my_rides() where sunday=$1", [S2])))[0].status, "requested");
  assert.equal((await as("c1", () => q("select * from my_route($1)", [S2]))).length, 0, "the driver doesn't see them yet");
  assert.equal((await q("select resolved from alerts where id=$1", [al.id]))[0].resolved, true);
});

test("services: special days take requests, a Sunday can be called off, a cutoff can be set", async () => {
  Object.assign(U, { s1: "00000000-0000-0000-0000-0000000000e1" });
  await db.query("insert into auth.users (id,email) values ($1,'s1@example.com')", [U.s1]);
  await db.query("insert into profiles (user_id,full_name,role) values ($1,'Sam Rider','rider')", [U.s1]);
  const sam = (await q("select id from profiles where user_id=$1", [U.s1]))[0].id;
  const day = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
  const weekday = (() => { for (let n = 10; ; n++) { const d = new Date(Date.now() + n * 86400000); if (d.getUTCDay() === 4) return d.toISOString().slice(0, 10); } })();
  const req = (date) => as("s1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [sam, date]));

  await assert.rejects(() => req(weekday), /no service on that day/);
  await as("leader", () => db.query("insert into services (service_date,title,start_time) values ($1,'Christmas Eve service','19:00')", [weekday]));
  await req(weekday); // now accepted

  // Special services can be booked further ahead than ordinary Sundays (up to 120 days).
  const far = (() => { for (let n = 60; ; n++) { const d = new Date(Date.now() + n * 86400000); if (d.getUTCDay() === 5) return d.toISOString().slice(0, 10); } })();
  await as("leader", () => db.query("insert into services (service_date,title,start_time) values ($1,'Good Friday service','10:00')", [far]));
  await req(far);

  const off = sundayInDays(28);
  await as("leader", () => db.query("insert into services (service_date,cancelled) values ($1,true)", [off]));
  await assert.rejects(() => req(off), /no service on/);

  const early = sundayInDays(35);
  await as("leader", () => db.query("insert into services (service_date,title,start_time,cutoff) values ($1,'Joint service','10:00',now() - interval '1 hour')", [early]));
  await assert.rejects(() => req(early), /closed/);

  // Everyone signed in can read the services; only the leader can change them.
  assert.ok((await as("s1", () => q("select * from services"))).length >= 4);
  await assert.rejects(() => as("s1", () => db.query("insert into services (service_date) values ($1)", [day(50)])), /row-level security/);
});

test("team: only the supervisor changes who leads; two leaders at most; leaders can't promote anyone", async () => {
  Object.assign(U, { t1: "00000000-0000-0000-0000-0000000000b1", t2: "00000000-0000-0000-0000-0000000000b2", t3: "00000000-0000-0000-0000-0000000000b3" });
  const ids = {};
  for (const [k, name, role] of [["t1", "Tom Driver", "driver"], ["t2", "Tia Rider", "rider"], ["t3", "Ted Rider", "rider"]]) {
    await db.query("insert into auth.users (id,email) values ($1,$2)", [U[k], `${k}@example.com`]);
    await db.query("insert into profiles (user_id,full_name,role,seats) values ($1,$2,$3,3)", [U[k], name, role]);
    ids[k] = (await q("select id from profiles where user_id=$1", [U[k]]))[0].id;
  }
  // The update file makes the first leader the supervisor.
  await db.exec(`update profiles set is_supervisor = true, leader_title = 'Supervisor' where id = (select id from profiles where role = 'leader' order by created_at limit 1) and not exists (select 1 from profiles where is_supervisor)`);
  assert.equal((await q("select is_supervisor from profiles where id=$1", [P.leader]))[0].is_supervisor, true);
  // Only one supervisor can exist.
  await assert.rejects(() => db.query("update profiles set role='leader', is_supervisor=true where id=$1", [ids.t3]), /duplicate key|unique/);

  // A rider can't promote themselves, and can't call the team functions.
  await as("t2", () => db.query("update profiles set role='leader', is_supervisor=true, leader_title='Leader' where id=$1", [ids.t2]));
  assert.deepEqual({ ...(await q("select role,is_supervisor,leader_title from profiles where id=$1", [ids.t2]))[0] }, { role: "rider", is_supervisor: false, leader_title: null });
  await assert.rejects(() => as("t2", () => db.query("select set_team_role($1,'leader')", [ids.t2])), /Only the supervisor/);

  // The supervisor makes Tom (a cleared driver) leader and Tia assistant.
  await db.query("update profiles set driver_status='cleared', licence_ok=true where id=$1", [ids.t1]);
  await as("leader", () => db.query("select set_team_role($1,'leader')", [ids.t1]));
  await as("leader", () => db.query("select set_team_role($1,'assistant')", [ids.t2]));
  assert.deepEqual((await q("select role,leader_title from profiles where id = any($1) order by full_name", [[ids.t1, ids.t2]])).map((r) => ({ ...r })),
    [{ role: "leader", leader_title: "Assistant leader" }, { role: "leader", leader_title: "Leader" }]);
  // A third leader is refused.
  await assert.rejects(() => as("leader", () => db.query("select set_team_role($1,'assistant')", [ids.t3])), /already two leaders/);

  // A leader (not supervisor) can manage drivers but can't change who leads, even by editing profiles.
  await assert.rejects(() => as("t1", () => db.query("select set_team_role($1,'rider')", [ids.t2])), /Only the supervisor/);
  await as("t1", () => db.query("update profiles set role='rider', leader_title=null where id=$1", [ids.t2]));
  await as("t1", () => db.query("update profiles set role='leader' where id=$1", [ids.t3]));
  await as("t1", () => db.query("update profiles set role='rider', is_supervisor=false where id=$1", [P.leader]));
  assert.equal((await q("select role from profiles where id=$1", [ids.t2]))[0].role, "leader");
  assert.equal((await q("select role from profiles where id=$1", [ids.t3]))[0].role, "rider");
  assert.equal((await q("select is_supervisor from profiles where id=$1", [P.leader]))[0].is_supervisor, true);
  // ...and the supervisor can't change their own role without handing over.
  await assert.rejects(() => as("leader", () => db.query("select set_team_role($1,'rider')", [P.leader])), /hand over/);

  // Moving Tom back to driver keeps his car and checks.
  await as("leader", () => db.query("select set_team_role($1,'driver')", [ids.t1]));
  assert.deepEqual({ ...(await q("select role,leader_title,driver_status,licence_ok,seats from profiles where id=$1", [ids.t1]))[0] },
    { role: "driver", leader_title: null, driver_status: "cleared", licence_ok: true, seats: 3 });

  // Hand over: only to a leader; the old supervisor chooses what they become.
  await assert.rejects(() => as("leader", () => db.query("select hand_over_supervisor($1,'rider')", [ids.t3])), /leader first/);
  await as("leader", () => db.query("select hand_over_supervisor($1,'assistant')", [ids.t2]));
  assert.deepEqual({ ...(await q("select role,is_supervisor,leader_title from profiles where id=$1", [ids.t2]))[0] }, { role: "leader", is_supervisor: true, leader_title: "Supervisor" });
  assert.deepEqual({ ...(await q("select role,is_supervisor,leader_title from profiles where id=$1", [P.leader]))[0] }, { role: "leader", is_supervisor: false, leader_title: "Assistant leader" });
  // The new supervisor can now move the old one; the old one can't do supervisor things any more.
  await assert.rejects(() => as("leader", () => db.query("select set_team_role($1,'leader')", [ids.t3])), /Only the supervisor/);
  await as("t2", () => db.query("select set_team_role($1,'leader')", [P.leader]));
  assert.equal((await q("select leader_title from profiles where id=$1", [P.leader]))[0].leader_title, "Leader");

  // Every change is in the log, readable by leaders only.
  const log = await as("leader", () => q("select change from team_log order by id"));
  assert.deepEqual(log.map((r) => r.change), [
    "made Tom Driver leader", "made Tia Rider assistant leader", "made Tom Driver driver",
    "handed the supervisor role to Tia Rider", "made Leader leader",
  ]);
  assert.equal((await as("t3", () => q("select * from team_log"))).length, 0);

  // Hand back, so the leader used by other tests is the supervisor again.
  await as("t2", () => db.query("select hand_over_supervisor($1,'rider')", [P.leader]));
  assert.equal((await q("select is_supervisor from profiles where id=$1", [P.leader]))[0].is_supervisor, true);
  assert.equal((await q("select role from profiles where id=$1", [ids.t2]))[0].role, "rider");
});

test("leaders see who signed in but never registered; nobody else can", async () => {
  const ghost = "00000000-0000-0000-0000-0000000000c9";
  await db.query("insert into auth.users (id,email,last_sign_in_at) values ($1,'ghost@example.com',now())", [ghost]);
  const rows = await as("leader", () => q("select * from unregistered_people()"));
  assert.ok(rows.some((r) => r.email === "ghost@example.com"));
  assert.ok(!rows.some((r) => r.email === "leader@example.com"));
  await assert.rejects(() => as("r1", () => q("select * from unregistered_people()")), /Only leaders/);
});

test("notifications: devices are saved per person; alerts, help asks and new drivers queue messages; only the sender can claim them", async () => {
  const sub = (n) => [`https://push.example.com/${n}`, "BP256dhKey", "authSecret", "Test phone"];
  // Fresh people (earlier tests remove some).
  Object.assign(U, { nd: "00000000-0000-0000-0000-0000000001a1", nr: "00000000-0000-0000-0000-0000000001a2", nr2: "00000000-0000-0000-0000-0000000001a3" });
  for (const [k, name, role] of [["nd", "Dee Push", "driver"], ["nr", "Rita Push", "rider"], ["nr2", "Ray Push", "rider"]]) {
    await db.query("insert into auth.users (id,email) values ($1,$2)", [U[k], `${k}@example.com`]);
    await db.query("insert into profiles (user_id,full_name,role,seats) values ($1,$2,$3,3)", [U[k], name, role]);
  }
  const N = {};
  for (const k of ["nd", "nr", "nr2"]) N[k] = (await q("select id from profiles where user_id=$1", [U[k]]))[0].id;
  await as("leader", () => db.query("select save_push_sub($1,$2,$3,$4)", sub("leader")));
  await as("nd", () => db.query("select save_push_sub($1,$2,$3,$4)", sub("d1")));
  await as("nr", () => db.query("select save_push_sub($1,$2,$3,$4)", sub("r1")));
  await assert.rejects(() => as("nr", () => db.query("select save_push_sub('http://evil.example/x','a','b')")), /not valid/);
  // People see only their own device; leaders see who has notifications on, not device details.
  assert.equal((await as("nr", () => q("select * from push_subs"))).length, 1);
  assert.equal((await as("leader", () => q("select * from push_subs"))).length, 1);
  const on = (await as("leader", () => q("select push_people() as id"))).map((r) => r.id);
  assert.ok(on.includes(N.nr) && on.includes(N.nd));
  await assert.rejects(() => as("nr", () => q("select push_people()")), /Only leaders/);
  await db.exec("delete from push_queue");

  // An alert reaches the leaders.
  await db.query("insert into alerts (kind, message) values ('rider_cancel', 'Rita cancelled.')");
  // A last-minute ask reaches that driver.
  const [h] = await as("leader", () => q("insert into help_requests (sunday, rider_name, address, neighbourhood) values ($1,'Joe Bloggs','1 Main St','Nutana') returning id", [SUN]));
  await as("leader", () => db.query("insert into help_asks (request_id, driver_id) values ($1,$2)", [h.id, N.nd]));
  // The leader's approval messages; people without notifications are skipped.
  const n = await as("leader", () => q("select queue_push($1::jsonb) as n", [JSON.stringify([
    { profile_id: N.nr, title: "Your ride is confirmed", body: "Dee picks you up at 10:50 AM.", tag: "ride" },
    { profile_id: N.nr2, title: "Your ride is confirmed", body: "No device.", tag: "ride" }])]));
  assert.equal(n[0].n, 1);
  await assert.rejects(() => as("nr", () => q("select queue_push('[]'::jsonb)")), /Only leaders/);

  // Riders and leaders can't read or claim the queue.
  assert.equal((await as("nr", () => q("select * from push_queue"))).length, 0);
  await assert.rejects(() => as("leader", () => q("select * from claim_push()")), /permission denied/);
  // The Edge Function (service role) claims each message once.
  await db.exec("set role service_role");
  const claimed = await q("select * from claim_push() order by queue_id");
  const again = await q("select * from claim_push()");
  await db.exec("reset role");
  assert.deepEqual(claimed.map((c) => [c.title, c.endpoint]), [
    ["Rides alert", "https://push.example.com/leader"],
    ["Can you help with a ride?", "https://push.example.com/d1"],
    ["Your ride is confirmed", "https://push.example.com/r1"],
  ]);
  assert.match(claimed[1].body, /^Joe in Nutana needs a ride on \w+day\. Open the app/);
  assert.equal(again.length, 0);

  // Turning off removes only your own device.
  await as("nd", () => db.query("select remove_push_sub($1)", ["https://push.example.com/r1"]));
  await as("nr", () => db.query("select remove_push_sub($1)", ["https://push.example.com/r1"]));
  assert.deepEqual((await q("select endpoint from push_subs order by endpoint")).map((r) => r.endpoint), ["https://push.example.com/d1", "https://push.example.com/leader"]);
});

test("notifications: a new driver waiting for approval tells the leaders", async () => {
  await db.exec("delete from push_queue");
  const u = "00000000-0000-0000-0000-0000000000c8";
  await db.query("insert into auth.users (id,email) values ($1,'newdriver@example.com')", [u]);
  await as("d2", () => q("select 1")); // no-op, keeps the session helper warm
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${u}',false), set_config('request.jwt.claim.email','newdriver@example.com',false);`);
  await db.query("insert into profiles (user_id, full_name, role, seats) values ($1,'Nia Newdriver','driver',3)", [u]);
  await db.exec("reset role");
  const rows = await q("select title, body from push_queue");
  assert.deepEqual(rows.map((r) => r.title), ["New driver to approve"]);
  assert.match(rows[0].body, /^Nia Newdriver registered as a driver/);
});

test("a home can be saved with a pin the person placed; unknown sources are refused", async () => {
  const u = "00000000-0000-0000-0000-0000000001b1";
  await db.query("insert into auth.users (id,email) values ($1,'pin@example.com')", [u]);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${u}',false), set_config('request.jwt.claim.email','pin@example.com',false);`);
  try {
    await db.query("insert into profiles (user_id,full_name,home_address,lat,lng,geo_source) values ($1,'Pat Pin','12 Somewhere St',52.12,-106.65,'pin')", [u]);
    await db.query("update profiles set geo_source='gps' where user_id=$1", [u]);
    await db.query("update profiles set geo_source='pin' where user_id=$1", [u]);
    await assert.rejects(() => db.query("update profiles set geo_source='guess' where user_id=$1", [u]), /check constraint/);
  } finally { await db.exec("reset role"); }
  assert.equal((await q("select geo_source from profiles where user_id=$1", [u]))[0].geo_source, "pin");
});

test("a rider who cancels from a shared plan: their driver gets a notification (not for a draft)", async () => {
  const ids = {};
  for (const [k, uid, name, role] of [["dr", "00000000-0000-0000-0000-0000000001c1", "Dora Driver", "driver"], ["rr", "00000000-0000-0000-0000-0000000001c2", "Remi Rider", "rider"]]) {
    await db.query("insert into auth.users (id,email) values ($1,$2)", [uid, `${k}@example.com`]);
    await db.query("insert into profiles (user_id,full_name,role,seats,driver_status) values ($1,$2,$3,3,$4)", [uid, name, role, role === "driver" ? "cleared" : "none"]);
    ids[k] = (await q("select id from profiles where user_id=$1", [uid]))[0].id;
    U[k] = uid;
  }
  await as("dr", () => db.query("select save_push_sub('https://push.example.com/dora','k','a')"));
  const run = async (status, day) => {
    await db.exec("delete from push_queue");
    await db.query("insert into ride_requests (rider_id, sunday) values ($1,$2)", [ids.rr, day]);
    const [pl] = await q("insert into plans (sunday, status) values ($1,$2) returning id", [day, status]);
    await db.query("insert into assignments (plan_id, rider_id, driver_id, trip, pickup_min) values ($1,$2,$3,1,650)", [pl.id, ids.rr, ids.dr]);
    await as("rr", () => db.query("update ride_requests set status='cancelled' where rider_id=$1 and sunday=$2", [ids.rr, day]));
    return q("select profile_id, title, body from push_queue where profile_id=$1", [ids.dr]);
  };
  const shared = await run("approved", sundayInDays(42));
  assert.equal(shared.length, 1);
  assert.equal(shared[0].title, "Change to your pickups");
  assert.match(shared[0].body, /^Remi cancelled their ride for Sunday, so you don't need to pick them up\./);
  assert.equal((await run("draft", sundayInDays(49))).length, 0);
});

test("a test notification goes only to yourself, and only if this person has a device saved", async () => {
  await db.exec("delete from push_queue");
  const mine = await as("dr", () => q("select push_test() as n"));
  assert.equal(mine[0].n, 1);
  const rows = await q("select p.full_name, q.title from push_queue q join profiles p on p.id = q.profile_id");
  assert.deepEqual(rows.map((r) => [r.full_name, r.title]), [["Dora Driver", "Notifications are on ✓"]]);
  assert.equal((await as("rr", () => q("select push_test() as n")))[0].n, 0);
});
