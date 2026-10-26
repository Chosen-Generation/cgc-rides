import test from "node:test";
import assert from "node:assert/strict";
import { approvalPings } from "../js/notify.js";
import { pushCard } from "../js/views.js";

const people = new Map([["d1", { id: "d1", name: "Grace Adeyemi" }], ["d2", { id: "d2", name: "Daniel Okafor" }]]);
const A = (riderId, driverId, pickupMin, departMin, seats = 1) => ({ riderId, driverId, pickupMin, departMin, trip: 1, seats });
const SUN = "2026-10-25";

test("first approval: every rider and driver in the plan hears", () => {
  const pings = approvalPings({ before: { status: "draft", assignments: [] }, after: { assignments: [A("r1", "d1", 650, 640), A("r2", "d1", 655, 640, 2)], waitlist: [] }, sunday: SUN, profilesById: people });
  assert.deepEqual(pings.map((p) => [p.profileId, p.title]), [["r1", "Your ride is confirmed"], ["r2", "Your ride is confirmed"], ["d1", "Your route is ready"]]);
  assert.match(pings[0].body, /^Grace will pick you up at 10:50 AM for Sunday, October 25\./);
  assert.match(pings[2].body, /^3 people to pick up for Sunday, October 25\. Leave home by 10:40 AM\./);
});

test("re-approval: only people whose ride changed hear", () => {
  const before = { status: "approved", assignments: [A("r1", "d1", 650, 640), A("r2", "d1", 655, 640), A("r3", "d2", 660, 650)] };
  // r2 moves to Daniel; r3 loses the seat (waiting list); r1 is untouched.
  const after = { assignments: [A("r1", "d1", 650, 640), A("r2", "d2", 652, 645)], waitlist: [{ riderId: "r3" }] };
  const pings = approvalPings({ before, after, sunday: SUN, profilesById: people });
  const by = Object.fromEntries(pings.map((p) => [p.profileId, p]));
  assert.ok(!by.r1);
  assert.equal(by.r2.title, "Your ride has changed");
  assert.match(by.r2.body, /^Daniel will pick you up at 10:52 AM/);
  assert.match(by.r3.body, /couldn't keep your seat/);
  assert.equal(by.d1.title, "Your route has changed");
  assert.match(by.d1.body, /^1 person to pick up/);
  assert.equal(by.d2.title, "Your route has changed");
  assert.equal(pings.length, 4);
  // Approving again with no change sends nothing.
  assert.equal(approvalPings({ before: { status: "approved", assignments: after.assignments }, after, sunday: SUN, profilesById: people }).length, 0);
});

test("the notifications card: invitation, iPhone guide, line when on, nothing when unsupported", () => {
  const S = (push, extra = {}) => ({ push, me: { role: "rider" }, tab: "rides", ...extra });
  assert.match(pushCard(S("off")), /Allow notifications/);
  assert.match(pushCard(S("off")), /when your ride is confirmed or changes/);
  assert.match(pushCard(S("ios-install")), /Add to Home Screen/);
  assert.equal(pushCard(S("on")), "");
  assert.match(pushCard(S("on", { tab: "details" })), /Notifications are on for this device/);
  assert.equal(pushCard(S("off", { pushLater: true })), "");
  assert.match(pushCard(S("off", { pushLater: true, tab: "details" })), /Allow notifications/);
  assert.equal(pushCard(S("blocked")), "");
  assert.match(pushCard(S("blocked", { tab: "details" })), /Notifications are blocked/);
  assert.equal(pushCard(S("unsupported")), "");
  assert.equal(pushCard(S(null)), "");
});

test("address reminders: pins placed by hand, and homes not on the map yet (people who can sign in)", async () => {
  const { remindGroups } = await import("../js/views.js");
  const P = (id, extra) => ({ id, userId: id, name: id, role: "rider", lat: 52.1, lng: -106.6, geoSource: "verified", ...extra });
  const S = { data: { profiles: [
    P("a", { geoSource: "pin" }), P("b", { geoSource: "gps" }), P("c", { geoSource: "none", lat: null, lng: null }),
    P("d", { geoSource: "none", lat: null, lng: null, userId: null }), // added by the leader: no sign-in
    P("e", { role: "leader", geoSource: "none", lat: null, lng: null }), // leader who doesn't drive
  ] } };
  const g = remindGroups(S);
  assert.deepEqual(g.pins.map((p) => p.id), ["a"]);
  assert.deepEqual(g.unconfirmed.map((p) => p.id), ["c"]);
});

test("the notifications card shows what happened after tapping Allow", () => {
  const S = (push, pushNote, tab = "rides") => ({ push, pushNote, me: { role: "driver" }, tab });
  assert.match(pushCard(S("off", { kind: "wait", text: "Your phone should now ask" })), /Your phone should now ask[\s\S]*Allow notifications/);
  assert.match(pushCard(S("off", { kind: "warn", text: "The question was closed" })), /pushnote warn[\s\S]*Try again/);
  assert.match(pushCard(S("on", { kind: "ok", text: "✓ Notifications are on." })), /pushnote ok/);
  assert.match(pushCard(S("blocked", { kind: "err", text: "Notifications were blocked" })), /pushnote err/);
});
