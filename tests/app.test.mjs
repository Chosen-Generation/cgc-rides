import test from "node:test";
import assert from "node:assert/strict";
import { createDemoStore } from "../js/store-demo.js";
import { CONFIG } from "../js/config.js";
import { DEMO_CHURCH } from "../js/demo-data.js";
import { draftPlan, recompute, applyMove, reassignDriver } from "../js/planner.js";
import { roleView, shell, landingView, esc } from "../js/views.js";
import { toISO } from "../js/dates.js";
import { createLiveStore } from "../js/store-live.js";

const NOW = new Date(2026, 9, 19, 10, 0); // Monday 19 Oct 2026
const church = { lat: DEMO_CHURCH.lat, lng: DEMO_CHURCH.lng };
const offline = async () => { throw new Error("offline"); }; // forces straight-line estimates

async function leaderCtx() {
  const store = createDemoStore({ now: () => NOW });
  store.viewAs("leader");
  const data = await store.leaderData();
  return { store, data, sunday: store.sundays()[0] };
}
const plan = (c) => draftPlan({ data: c.data, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });

test("demo: draft plan seats cleared drivers only, honours rules, and shows a waitlist reason", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const byId = new Map(c.data.profiles.map((x) => [x.id, x]));
  assert.ok(!p.assignments.some((a) => ["d-esther", "d-new"].includes(a.driverId)), "suspended/pending drivers must get nobody");
  assert.ok(p.excludedDrivers.length >= 2);
  const tobi = p.assignments.find((a) => a.riderId === "r-tobi");
  assert.ok(tobi && byId.get(tobi.driverId).status === "cleared");
  assert.match(p.waitlist.find((w) => w.riderId === "r-isaac")?.reason || "", /not confirmed/);
  assert.match(p.travelNote, /straight-line/);
});

test("demo: nobody sees a plan until it is approved, then drivers see only their riders", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const save = (status) => c.store.savePlan(c.sunday, status, {}, p.assignments, p.waitlist);
  await save("draft");
  c.store.viewAs("d-grace");
  assert.equal((await c.store.myRoute(c.sunday)).length, 0);
  c.store.viewAs("leader"); await save("approved");
  c.store.viewAs("d-grace");
  const route = await c.store.myRoute(c.sunday);
  const mine = p.assignments.filter((a) => a.driverId === "d-grace").length;
  assert.equal(route.length, mine);
  assert.ok(route.every((r) => r.address));
  c.store.viewAs("d-daniel");
  const names = (await c.store.myRoute(c.sunday)).map((r) => r.riderName);
  assert.ok(!names.some((n) => route.map((r) => r.riderName).includes(n)));
  c.store.viewAs("r-mary");
  const ride = (await c.store.myRides())[0];
  assert.equal(ride.status, "seated");
  assert.ok(ride.driverName && ride.readyByMin < ride.pickupMin);
  await assert.rejects(() => c.store.leaderData(), /Only the transport leader/);
});

test("demo: the plan can't be saved with an unsafe car (same rule as the database)", async () => {
  const c = await leaderCtx();
  const bad = [{ riderId: "r-mary", driverId: "d-esther", trip: 1 }];
  await assert.rejects(() => c.store.savePlan(c.sunday, "draft", {}, bad, []), /cleared drivers/);
  const full = ["r-mary", "r-peter", "r-amara"].map((r) => ({ riderId: r, driverId: "d-samuel", trip: 1 }));
  await assert.rejects(() => c.store.savePlan(c.sunday, "draft", {}, full, []), /more people than seats/);
});

test("demo: moving a rider re-times the plan; a driver cancelling re-places only their riders", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const to = "d-ruth|1";
  const old = p.assignments.find((a) => a.riderId === "r-david");
  const moved = applyMove(p, "r-david", to, `${old.driverId}|${old.trip}`);
  assert.equal(moved.assignments.filter((a) => a.riderId === "r-david").length, 1);
  const r2 = await recompute({ data: c.data, sunday: c.sunday, church, config: CONFIG, ...moved, fetchFn: offline });
  assert.equal(r2.assignments.find((a) => a.riderId === "r-david").driverId, "d-ruth");

  const victim = "d-grace";
  const before = p.assignments.filter((a) => a.driverId !== victim);
  const re = await reassignDriver({ data: c.data, sunday: c.sunday, church, config: CONFIG, current: p, driverId: victim, fetchFn: offline });
  assert.ok(!re.assignments.some((a) => a.driverId === victim));
  for (const a of before) assert.ok(re.assignments.some((x) => x.riderId === a.riderId && x.driverId === a.driverId), "unaffected riders stay put");
  const affected = p.assignments.filter((a) => a.driverId === victim).map((a) => a.riderId);
  for (const id of affected) assert.ok(re.assignments.some((x) => x.riderId === id) || re.waitlist.some((w) => w.riderId === id));
});

test("demo: requests are refused after Saturday noon", async () => {
  const sat = new Date(2026, 9, 24, 13, 0);
  const store = createDemoStore({ now: () => sat });
  store.viewAs("r-lydia");
  await assert.rejects(() => store.requestRide(store.sundays()[0]), /closed/);
});

test("views: every role renders, escapes user text, and never shows undefined/NaN", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  await c.store.savePlan(c.sunday, "approved", {}, p.assignments, p.waitlist);
  c.store.viewAs("r-peter");
  await c.store.saveMyProfile({ name: '<img src=x onerror=alert(1)>' });
  for (const id of ["leader", "d-grace", "d-new", "d-esther", "r-mary", "r-peter", "r-tobi", "r-isaac"]) {
    c.store.viewAs(id);
    const me = await c.store.getMe();
    const S = { config: CONFIG, mode: "demo", session: { userId: id, email: "x" }, me, now: NOW, todayISO: toISO(NOW), sundays: c.store.sundays(), sunday: c.sunday, tab: null,
      rides: me.role === "rider" ? await c.store.myRides() : [], weeks: me.role === "driver" ? await c.store.myWeeks() : [],
      routes: {}, church, demoChurchLabel: "demo", planView: null, data: null, editing: null, demoPeople: c.store.people() };
    if (me.role === "driver") for (const s of S.sundays) S.routes[s] = await c.store.myRoute(s);
    if (me.role === "leader") {
      S.data = await c.store.leaderData();
      S.planView = { status: "approved", assignments: S.data.plans[c.sunday].assignments, waitlist: S.data.plans[c.sunday].waitlist, warnings: [], excluded: [], dirty: false };
      for (const tab of ["plan", "people", "alerts", "texts"]) {
        S.tab = tab; const html = roleView(S); assert.ok(!/undefined|NaN|\[object/.test(html), `leader ${tab}: ${html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]}`);
      }
    } else {
      S.tab = me.role === "driver" ? "sundays" : "rides";
      const html = shell(S, roleView(S));
      assert.ok(!/undefined|NaN|\[object/.test(html), `${id}: ${html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]}`);
      assert.ok(!html.includes("<img src=x"));
    }
  }
  assert.equal(esc(`<b>"x"&'</b>`), "&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;");
  assert.match(landingView({ mode: "demo" }), /Nobody in this church walks alone/);
});

test("live store: calls the right tables and functions (fake client; not a real Supabase test)", async () => {
  const log = [];
  const chain = (table) => {
    const q = { _t: table, calls: [] };
    const h = { get(t, k) { if (k === "then") return (res) => res({ data: table === "profiles" ? [] : [], error: null }); return (...a) => { log.push([table, k, ...a]); return new Proxy(q, h); }; } };
    return new Proxy(q, h);
  };
  const fake = { auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "a@b.c" } } } }), onAuthStateChange() {}, signInWithOtp: async (a) => { log.push(["otp", a.email]); return {}; }, verifyOtp: async (a) => { log.push(["verify", a.email, a.token, a.type]); return a.token === "000000" ? { error: { message: "Token has expired or is invalid" } } : { data: { user: { id: "u2", email: a.email } }, error: null }; }, signOut: async () => ({}) },
    from: (t) => chain(t), rpc: async (fn, args) => { log.push(["rpc", fn, args]); return { data: [], error: null }; } };
  const cfg = { ...CONFIG, supabase: { url: "https://x.supabase.co", anonKey: "k" } };
  const s = await createLiveStore(cfg, { createClient: () => fake });
  await s.init();
  assert.equal(s.session().email, "a@b.c");
  await s.verifyCode("z@y.x", "123 456");
  assert.deepEqual(log.find((l) => l[0] === "verify"), ["verify", "z@y.x", "123456", "email"]);
  assert.equal(s.session().email, "z@y.x");
  await assert.rejects(() => s.verifyCode("z@y.x", "000000"), /didn't work/);
  await s.myRides(); await s.myRoute("2026-10-25"); await s.cantMakeIt("2026-10-25", "sick");
  await s.savePlan("2026-10-25", "draft", {}, [], []); await s.giveConsent("words");
  await s.signIn("a@b.c");
  const rpcs = log.filter((l) => l[0] === "rpc").map((l) => l[1]);
  assert.deepEqual(rpcs, ["my_rides", "my_route", "driver_cant_make_it", "save_plan", "give_text_consent"]);
  assert.deepEqual(log.find((l) => l[1] === "save_plan")[2], { p_sunday: "2026-10-25", p_status: "draft", p_summary: {}, p_assignments: [], p_waitlist: [] });
  assert.ok(log.some((l) => l[0] === "otp"));
});

test("demo: a rider asks with people coming along; the leader can agree to a split; drivers see their share", async () => {
  const c = await leaderCtx();
  await c.store.setVanDriver(c.sunday, null); // no church van this day: only cars
  c.store.viewAs("r-lydia");
  await c.store.requestRide(c.sunday, { extraPeople: 6, canSplit: false, note: "Bringing my family" });
  c.store.viewAs("leader");
  const data = await c.store.leaderData();
  const req = data.requests.find((r) => r.riderId === "r-lydia" && r.sunday === c.sunday);
  assert.equal(req.extraPeople, 6);
  const p = await draftPlan({ data, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });
  const w = p.waitlist.find((x) => x.riderId === "r-lydia");
  assert.ok(w && w.seats === 7 && /split/.test(w.reason));
  // Leader asked, they agreed: re-place just that group.
  await c.store.updateRequest("r-lydia", c.sunday, { canSplit: true });
  const data2 = await c.store.leaderData();
  const keep = p.assignments.filter((a) => a.riderId !== "r-lydia");
  const p2 = await draftPlan({ data: data2, sunday: c.sunday, church, config: CONFIG, keep, fetchFn: offline });
  for (const a of keep) assert.ok(p2.assignments.some((x) => x.riderId === a.riderId && x.driverId === a.driverId), "others stay put");
  const placed = p2.assignments.filter((a) => a.riderId === "r-lydia").reduce((n, a) => n + a.seats, 0);
  const waiting = p2.waitlist.find((x) => x.riderId === "r-lydia")?.seats || 0;
  assert.equal(placed + waiting, 7);
  // Approve (use only what fits), then the rider and drivers see their share.
  await c.store.savePlan(c.sunday, "approved", {}, p2.assignments, p2.waitlist);
  c.store.viewAs("r-lydia");
  const rows = await c.store.myRides();
  const mine = rows.filter((r) => r.sunday === c.sunday);
  if (placed > 0) { assert.equal(mine.reduce((n, r) => n + (r.seats || 0), 0), placed); assert.ok(mine.every((r) => r.driverName)); }
  const dId = p2.assignments.find((a) => a.riderId === "r-lydia")?.driverId;
  if (dId) { c.store.viewAs(dId); const route = await c.store.myRoute(c.sunday); const row = route.find((r) => r.riderName === "Lydia Chen"); assert.ok(row.seats >= 1 && row.partyTotal === 7); }
  // A car can't be saved over-full by people count.
  c.store.viewAs("leader");
  await assert.rejects(() => c.store.savePlan(c.sunday, "draft", {}, [{ riderId: "r-lydia", driverId: "d-samuel", trip: 1, seats: 5 }], []), /more people than seats/);
});

test("demo: a leader can also drive: appears as a driver, sees their own pickups, can say they can't make it", async () => {
  const c = await leaderCtx();
  await c.store.saveMyProfile({ seats: 3, vehicle: "Leader's car", drivesEveryWeek: true, status: "cleared", role: "leader" });
  const data = await c.store.leaderData();
  const me = data.profiles.find((p) => p.id === "leader");
  assert.equal(me.role, "leader");
  assert.equal(me.status, "cleared");
  // Make the other drivers unavailable so the leader must carry people.
  const weeks = [...data.weeks, ...data.profiles.filter((p) => p.role === "driver").map((d) => ({ driverId: d.id, sunday: c.sunday, available: false }))];
  const p = await draftPlan({ data: { ...data, weeks }, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });
  const mine = p.assignments.filter((a) => a.driverId === "leader");
  assert.ok(mine.length > 0 && mine.length <= 3);
  await c.store.savePlan(c.sunday, "approved", {}, p.assignments, p.waitlist);
  const route = await c.store.myRoute(c.sunday);
  assert.equal(route.length, mine.length);
  assert.equal(await c.store.cantMakeIt(c.sunday), mine.length);
});

test("team: the supervisor makes leaders (two at most), moves them back, and hands over", async () => {
  const store = createDemoStore();
  store.viewAs("leader");
  await store.setTeamRole("d-grace", "leader");
  await store.setTeamRole("r-isaac", "assistant");
  await assert.rejects(() => store.setTeamRole("d-daniel", "assistant"), /already two leaders/);
  await assert.rejects(() => store.setTeamRole("leader", "rider"), /hand over/);
  // A leader who isn't the supervisor can't change the team, even through a profile edit.
  store.viewAs("d-grace");
  assert.ok(await store.leaderData());
  await assert.rejects(() => store.setTeamRole("r-isaac", "rider"), /Only the supervisor/);
  await store.saveProfile({ id: "r-isaac", role: "rider", isSupervisor: true });
  await store.saveProfile({ id: "d-daniel", role: "leader" });
  store.viewAs("leader");
  let ppl = (await store.leaderData()).profiles;
  const get = (id) => ppl.find((p) => p.id === id);
  assert.equal(get("r-isaac").role, "leader");
  assert.equal(get("r-isaac").isSupervisor, undefined);
  assert.equal(get("d-daniel").role, "driver");
  // Moving Grace back keeps her a cleared driver.
  await store.setTeamRole("d-grace", "driver");
  ppl = (await store.leaderData()).profiles;
  assert.deepEqual([get("d-grace").role, get("d-grace").status, get("d-grace").leaderTitle], ["driver", "cleared", null]);
  // Hand over to Isaac; the old supervisor becomes a driver and loses the leader screens.
  await assert.rejects(() => store.handOverSupervisor("d-daniel", "rider"), /leader first/);
  await store.handOverSupervisor("r-isaac", "driver");
  const me = await store.getMe();
  assert.deepEqual([me.role, !!me.isSupervisor, me.status], ["driver", false, "pending"]);
  await assert.rejects(() => store.leaderData(), /Only the transport leader/);
  store.viewAs("r-isaac");
  const d = await store.leaderData();
  assert.equal(d.profiles.find((p) => p.id === "r-isaac").isSupervisor, true);
  assert.deepEqual(d.teamLog.map((t) => t.change).reverse(), [
    "made Grace Adeyemi leader", "made Isaac Moyo assistant leader", "made Grace Adeyemi driver", "handed the supervisor role to Isaac Moyo"]);
});

test("church van: used only with a driver; their car stays home; it fills first; start from home", async () => {
  const c = await leaderCtx();
  const data = await c.store.leaderData();
  const p = await draftPlan({ data, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });
  const inVan = p.assignments.filter((a) => a.driverId === "van");
  assert.ok(inVan.length >= 2, "the van takes riders");
  assert.ok(!p.assignments.some((a) => a.driverId === "d-samuel"), "the van driver's own car isn't used");
  assert.ok(p.excludedDrivers.some((e) => e.driverId === "d-samuel" && /church van/.test(e.reason)));
  // The van's route starts at church: it leaves before its first pickup by the church-to-rider time.
  const trip = p.trips.find((t) => t.driverId === "van" && t.trip === 1);
  assert.ok(trip.departMin <= trip.stops[0].pickupMin);
  // No van driver: the van isn't used, Samuel's car is.
  await c.store.setVanDriver(c.sunday, null);
  const data2 = await c.store.leaderData();
  const p2 = await draftPlan({ data: data2, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });
  assert.ok(!p2.assignments.some((a) => a.driverId === "van"));
  assert.ok(p2.excludedDrivers.some((e) => e.driverId === "van" && /No van driver/.test(e.reason)));
  // Starting from the driver's home: the van's start point is their house.
  await c.store.setVanDriver(c.sunday, "d-grace", "home");
  const { withVan } = await import("../js/van.js");
  const data3 = await c.store.leaderData();
  const van = withVan(data3.profiles.filter((x) => x.role === "driver"), data3, c.sunday).find((d) => d.isVehicle);
  const grace = data3.profiles.find((x) => x.id === "d-grace");
  assert.deepEqual([van.lat, van.lng, van.vanStart], [grace.lat, grace.lng, "home"]);
  // Approving a plan with the van needs a van driver.
  await c.store.setVanDriver(c.sunday, null);
  await assert.rejects(() => c.store.savePlan(c.sunday, "approved", {}, inVan, []), /Choose who drives the church van/);
});

test("church van notifications go to the person driving it", async () => {
  const { approvalPings } = await import("../js/notify.js");
  const people = new Map([["van", { id: "van", isVehicle: true, name: "Samuel Boateng (church van)", vanDriverId: "d-samuel", vanStart: "church" }]]);
  const pings = approvalPings({ before: null, after: { assignments: [{ riderId: "r1", driverId: "van", trip: 1, pickupMin: 620, departMin: 600, seats: 1 }], waitlist: [] }, sunday: "2026-11-08", profilesById: people });
  assert.deepEqual(pings.map((x) => x.profileId), ["r1", "d-samuel"]);
  assert.match(pings[0].body, /^Samuel \(church van\) will pick you up at 10:20 AM/);
  assert.match(pings[1].body, /^1 person to pick up in the church van .* Leave the church \(with the van\) by 10:00 AM\./);
});
