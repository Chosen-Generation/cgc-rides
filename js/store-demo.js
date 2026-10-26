// DEMO store: everything lives in memory, nothing leaves the browser, a refresh resets it.
// It follows the same visibility rules as the real database so the demo shows true behaviour.

import { makeDemoState, DEMO_CHURCH } from "./demo-data.js";
import { nextSundays } from "./dates.js";
import { serviceFor, isClosedFor, setServices } from "./services.js";
import { validatePlan } from "./models.js";
import { geocode } from "./geo.js";

export function createDemoStore({ now = () => new Date() } = {}) {
  let db = makeDemoState(now());
  let viewer = null;
  const byId = (id) => db.profiles.find((p) => p.id === id);
  const me = () => (viewer ? byId(viewer) : null);
  const isLeader = () => me()?.role === "leader";
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const fresh = (o) => JSON.parse(JSON.stringify(o));

  return {
    mode: "demo",
    demoChurch: DEMO_CHURCH,
    async init() { return null; },
    session() { return viewer ? { userId: viewer, email: me().email } : null; },
    people() { return db.profiles.filter((p) => p.id !== "d-new" || true).map((p) => ({ id: p.id, name: p.name, role: p.role, status: p.status })); },
    viewAs(id) { viewer = id; },
    async exportAll() { return fresh({ profiles: db.profiles, requests: db.requests, weeks: db.weeks, plans: db.plans, alerts: db.alerts, consentLog: db.consentLog }); },
    async verifyCode() { throw new Error("Codes aren't used in the demo."); },
    async signOut() { viewer = null; },
    reset() { db = makeDemoState(now()); },
    sundays() { return db.sundays; },

    async getMe() { return me() ? fresh(me()) : null; },

    async saveMyProfile(patch) {
      need(viewer, "Not signed in");
      const p = me();
      const allowed = ["name", "phone", "gender", "address", "postalCode", "neighbourhood", "lat", "lng", "geoSource", "minor",
        "weeklyCheckin", "notes", "seats", "drivesEveryWeek", "secondTrip", "vehicle", "role"];
      if (p.role === "leader") allowed.push("status");
      for (const k of allowed) if (k in patch && !(k === "role" && !["rider", "driver"].includes(patch.role))) p[k] = patch[k];
      if (p.role === "driver" && p.status === "none") p.status = "pending";
      return fresh(p);
    },

    // ---- rider
    async myRides() {
      const m = me();
      const rows = [];
      for (const r of db.requests.filter((x) => x.riderId === m.id && x.sunday >= db.sundays[0]).sort((a, b) => a.sunday.localeCompare(b.sunday))) {
        const plan = db.plans[r.sunday];
        const approved = plan?.status === "approved" && r.status !== "cancelled";
        const mine = approved ? plan.assignments.filter((x) => x.riderId === m.id).sort((a, b) => a.trip - b.trip) : [];
        const w = approved ? plan.waitlist.find((x) => x.riderId === m.id) : null;
        const base = { sunday: r.sunday, rideHome: r.rideHome, note: r.note, extraPeople: r.extraPeople || 0, canSplit: !!r.canSplit, waitlistedSeats: w ? w.seats ?? 1 : null };
        if (r.status === "cancelled") rows.push({ ...base, status: "cancelled" });
        else if (!mine.length) rows.push({ ...base, status: w ? "waitlisted" : "requested" });
        else for (const a of mine) {
          const d = byId(a.driverId);
          rows.push({ ...base, status: "seated", driverName: d.name, driverPhone: d.phone, vehicle: d.vehicle, seats: a.seats ?? 1, trip: a.trip, pickupMin: a.pickupMin, readyByMin: a.readyByMin, arriveMin: a.arriveMin });
        }
      }
      return rows;
    },
    async requestRide(sunday, { rideHome = false, note = null, extraPeople = 0, canSplit = false } = {}) {
      const m = me();
      // Same rules as the database: a service day, not called off, before its cutoff.
      setServices(db.services);
      const svc = serviceFor(sunday);
      need(!svc.cancelled, "There is no service on that day.");
      need(svc.sunday || svc.changed, "There is no service on that day.");
      need(!isClosedFor(sunday, now()), "Requests for this service have closed. Please contact the transport leader.");
      const ex = db.requests.find((r) => r.riderId === m.id && r.sunday === sunday);
      if (ex && ex.status === "cancelled") db.alerts.forEach((a) => { if (a.kind === "rider_cancel" && a.riderId === m.id && a.sunday === sunday) a.resolved = true; });
      if (ex) Object.assign(ex, { status: "requested", rideHome, note, extraPeople, canSplit });
      else db.requests.push({ id: `q-${m.id}-${sunday}`, riderId: m.id, sunday, rideHome, note, extraPeople, canSplit, status: "requested" });
    },
    async cancelRide(sunday) {
      const m = me();
      const r = db.requests.find((x) => x.riderId === m.id && x.sunday === sunday);
      need(r, "No request to cancel.");
      // Same as the database: the rider leaves the plan; asking again makes them a new request.
      const plan = db.plans[sunday];
      const seat = plan?.assignments.find((a) => a.riderId === m.id);
      if (plan) { plan.assignments = plan.assignments.filter((a) => a.riderId !== m.id); plan.waitlist = plan.waitlist.filter((w) => w.riderId !== m.id); }
      if (r.status !== "cancelled" && seat) {
        const d = byId(seat.driverId);
        db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "rider_cancel", sunday, riderId: m.id, driverId: seat.driverId, resolved: false,
          message: `${m.name} cancelled their ride for ${sunday}. They were in ${d?.name}'s car.`, createdAt: now().toISOString() });
      }
      r.status = "cancelled";
    },
    async giveConsent(wording, profileId = null) {
      const target = profileId && isLeader() ? byId(profileId) : me();
      need(target, "Create your profile first.");
      target.textsConsentAt = now().toISOString();
      target.textsConsentWithdrawnAt = null;
      db.consentLog.push({ profileId: target.id, kind: "given", wording, at: target.textsConsentAt });
    },
    async withdrawConsent(profileId = null) {
      const target = profileId && isLeader() ? byId(profileId) : me();
      target.textsConsentAt = null;
      target.textsConsentWithdrawnAt = now().toISOString();
      db.consentLog.push({ profileId: target.id, kind: "withdrawn", at: target.textsConsentWithdrawnAt });
    },

    // ---- driver
    async myWeeks() { return db.weeks.filter((w) => w.driverId === me().id).map(fresh); },
    async setAvailability(sunday, available, note = null) {
      const m = me();
      const ex = db.weeks.find((w) => w.driverId === m.id && w.sunday === sunday);
      if (ex) Object.assign(ex, { available, note });
      else db.weeks.push({ driverId: m.id, sunday, available, note });
    },
    async myRoute(sunday) {
      const m = me();
      const plan = db.plans[sunday];
      if (!plan || plan.status !== "approved") return [];
      return plan.assignments.filter((a) => a.driverId === m.id).sort((a, b) => a.trip - b.trip || a.order - b.order).map((a) => {
        const r = byId(a.riderId);
        const q = db.requests.find((x) => x.riderId === r.id && x.sunday === sunday);
        return { trip: a.trip, order: a.order, pickupMin: a.pickupMin, readyByMin: a.readyByMin, arriveMin: a.arriveMin, departMin: a.departMin ?? null,
          riderName: r.name, riderPhone: r.phone, address: r.address, neighbourhood: r.neighbourhood, lat: r.lat, lng: r.lng,
          minor: r.minor,
          riderNotes: r.notes, requestNote: q?.note ?? null, extraPeople: q?.extraPeople || 0, seats: a.seats ?? 1, partyTotal: 1 + (q?.extraPeople || 0), rideHome: !!q?.rideHome, cancelled: q?.status === "cancelled" };
      }).filter((x) => !x.cancelled);
    },
    async cantMakeIt(sunday, note = null) {
      const m = me();
      need(m.role === "driver" || (m.role === "leader" && m.seats > 0), "Only drivers can use this.");
      await this.setAvailability(sunday, false, note);
      const n = (db.plans[sunday]?.assignments || []).filter((a) => a.driverId === m.id).length;
      db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "driver_cancel", sunday, driverId: m.id, riderId: null, resolved: false,
        message: `${m.name} can't make it on ${sunday}. ${n} rider(s) need a new ride.${note ? ` Note: ${note}` : ""}`, createdAt: now().toISOString() });
      return n;
    },

    // ---- leader
    async leaderData() {
      need(isLeader(), "Only the transport leader can see this.");
      return fresh({ profiles: db.profiles, requests: db.requests, weeks: db.weeks, plans: db.plans, alerts: db.alerts, consentLog: db.consentLog, helpRequests: db.help, teamLog: db.teamLog,
        unregistered: db.unregistered, pushPeople: ["d-grace", "r-mary"] });
    },

    // ---- team (same rules as the database: only the supervisor; two leaders besides them at most)
    // ---- phone notifications: not sent in the demo
    async savePushSub() {}, async pushTest() { return { sent: 1 }; }, async removePushSub() {}, async queuePush(items) { const on = ["d-grace", "r-mary"]; const mine = items.filter((i) => on.includes(i.profileId)); db.pushLog.push(...mine); return mine.length; }, async flushPush() { return null; },
    pushLog() { return db.pushLog; },

    async setTeamRole(id, role) {
      const m = me();
      need(m?.isSupervisor, "Only the supervisor can change who leads.");
      need(["leader", "assistant", "driver", "rider"].includes(role), "Choose leader, assistant leader, driver or rider.");
      const t = byId(id);
      need(t, "That person was not found.");
      need(t.id !== m.id, "To change your own role, hand over the supervisor role first.");
      need(t.userId, `${t.name} has never signed in to the app, so they can't lead yet. Ask them to sign in once first.`);
      let label;
      if (role === "leader" || role === "assistant") {
        need(db.profiles.filter((p) => p.role === "leader" && !p.isSupervisor && p.id !== t.id).length < 2, "There are already two leaders. Move one of them back to driver or rider first.");
        label = role === "leader" ? "Leader" : "Assistant leader";
        Object.assign(t, { role: "leader", leaderTitle: label });
      } else {
        label = role === "driver" ? "Driver" : "Rider";
        Object.assign(t, { role, leaderTitle: null });
        if (role === "driver" && t.status === "none") t.status = "pending";
      }
      db.teamLog.unshift({ at: now().toISOString(), actorName: m.name, targetName: t.name, change: `made ${t.name} ${label.toLowerCase()}` });
      return label;
    },
    async handOverSupervisor(id, myRole) {
      const m = me();
      need(m?.isSupervisor, "Only the supervisor can hand over the role.");
      need(["leader", "assistant", "driver", "rider"].includes(myRole), "Choose what you will be: leader, assistant leader, driver or rider.");
      const t = byId(id);
      need(t && t.id !== m.id, "Choose someone else to hand over to.");
      need(t.role === "leader", `Make ${t.name} a leader first, then hand over.`);
      if (myRole === "leader" || myRole === "assistant") {
        need(db.profiles.filter((p) => p.role === "leader" && !p.isSupervisor && p.id !== m.id && p.id !== t.id).length < 2, "There are already two leaders, so you can't stay a leader. Choose driver or rider.");
      }
      Object.assign(t, { isSupervisor: true, leaderTitle: "Supervisor" });
      m.isSupervisor = false;
      if (myRole === "leader" || myRole === "assistant") m.leaderTitle = myRole === "leader" ? "Leader" : "Assistant leader";
      else { Object.assign(m, { role: myRole, leaderTitle: null }); if (myRole === "driver" && m.status === "none") m.status = "pending"; }
      db.teamLog.unshift({ at: now().toISOString(), actorName: m.name, targetName: t.name, change: `handed the supervisor role to ${t.name}` });
      return "ok";
    },

    // ---- last-minute requests (same rules as the database: first yes wins; address only for the winner)
    async createHelpRequest(req, asks) {
      need(isLeader(), "Only the transport leader can do this.");
      const id = `h${db.help.length + 1}`;
      db.help.unshift({ id, status: "open", acceptedBy: null, acceptedAt: null, createdAt: now().toISOString(), ...fresh(req),
        asks: asks.map((a) => ({ driverId: a.driverId, awayMin: a.awayMin, answer: null })) });
      return id;
    },
    async cancelHelpRequest(id) { need(isLeader(), "Only the transport leader can do this."); const h = db.help.find((x) => x.id === id); if (h) h.status = "cancelled"; },
    async myHelpRequests() {
      const m = me();
      return db.help.filter((h) => h.status !== "cancelled" && h.sunday >= db.sundays[0] && h.asks.some((a) => a.driverId === m.id)).map((h) => {
        const ask = h.asks.find((a) => a.driverId === m.id);
        const mine = h.acceptedBy === m.id;
        return { id: h.id, sunday: h.sunday, riderName: String(h.riderName).split(" ")[0], neighbourhood: h.neighbourhood, seats: h.seats, pickupMin: h.pickupMin,
          awayMin: ask.awayMin, status: h.status, myAnswer: ask.answer, mine, address: mine ? h.address : null, riderPhone: mine ? h.riderPhone : null };
      });
    },
    async answerHelp(id, answer) {
      const m = me();
      const h = db.help.find((x) => x.id === id);
      const ask = h?.asks.find((a) => a.driverId === m.id);
      need(ask, "This request was not sent to you.");
      ask.answer = answer;
      if (answer === "no") return "noted";
      if (h.status === "cancelled") return "cancelled";
      if (h.status === "covered") return h.acceptedBy === m.id ? "accepted" : "taken";
      Object.assign(h, { status: "covered", acceptedBy: m.id, acceptedAt: now().toISOString() });
      db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "info", sunday: h.sunday, driverId: m.id, riderId: null, resolved: false,
        message: `${m.name} said yes: they will pick up ${h.riderName} on ${h.sunday}.`, createdAt: now().toISOString() });
      return "accepted";
    },
    async savePlan(sunday, status, summary, assignments, waitlist) {
      need(isLeader(), "Only the transport leader can save a plan.");
      validatePlan({ profilesById: new Map(db.profiles.map((p) => [p.id, p])), sunday, assignments });
      db.plans[sunday] = { sunday, status, summary: summary || {}, assignments: fresh(assignments), waitlist: fresh(waitlist || []), approvedAt: status === "approved" ? now().toISOString() : null };
    },
    async removePerson(id) {
      need(isLeader(), "Only the transport leader can do this.");
      const victim = byId(id);
      need(victim, "That person was not found.");
      need(victim.role !== "leader", "Leaders cannot be removed here.");
      need(id !== viewer, "You cannot remove yourself.");
      let plansReopened = 0, ridesRemoved = 0;
      for (const plan of Object.values(db.plans)) {
        const mine = plan.assignments.filter((a) => a.riderId === id || a.driverId === id);
        if (!mine.length) continue;
        plansReopened++; ridesRemoved += mine.length;
        plan.assignments = plan.assignments.filter((a) => !mine.includes(a));
        plan.status = "draft"; plan.approvedAt = null;
      }
      for (const plan of Object.values(db.plans)) plan.waitlist = plan.waitlist.filter((w) => w.riderId !== id);
      db.profiles = db.profiles.filter((p) => p.id !== id);
      db.requests = db.requests.filter((r) => r.riderId !== id);
      db.weeks = db.weeks.filter((w) => w.driverId !== id);
      db.alerts = db.alerts.filter((a) => a.driverId !== id && a.riderId !== id);
      return { removed: victim.name, plansReopened, ridesRemoved };
    },
    async saveProfile(p) {
      need(isLeader(), "Only the transport leader can do this.");
      // As in the database, team roles change only through setTeamRole / handOverSupervisor.
      p = { ...p }; delete p.isSupervisor; delete p.leaderTitle;
      const old = p.id && byId(p.id);
      if (old && (old.role === "leader" || p.role === "leader")) p.role = old.role;
      if (!old && p.role === "leader") p.role = "rider";
      if (p.id && byId(p.id)) Object.assign(byId(p.id), p);
      else {
        const id = `p-${db.profiles.length + 1}`;
        db.profiles.push({ id, userId: null, email: null, role: "rider", status: "none", seats: 0, minor: false, priority: false, prefersSameGender: false, weeklyCheckin: false, ...p, id });
        return id;
      }
      return p.id;
    },
    async addRequest(riderId, sunday, { rideHome = false, note = null, extraPeople = 0, canSplit = false } = {}) {
      need(isLeader(), "Only the transport leader can do this.");
      const ex = db.requests.find((r) => r.riderId === riderId && r.sunday === sunday);
      if (ex && ex.status === "cancelled") db.alerts.forEach((a) => { if (a.kind === "rider_cancel" && a.riderId === m.id && a.sunday === sunday) a.resolved = true; });
      if (ex) Object.assign(ex, { status: "requested", rideHome, note, extraPeople, canSplit });
      else db.requests.push({ id: `q-${riderId}-${sunday}`, riderId, sunday, rideHome, note, extraPeople, canSplit, status: "requested" });
    },
    async updateRequest(riderId, sunday, patch) {
      need(isLeader(), "Only the transport leader can do this.");
      const r = db.requests.find((x) => x.riderId === riderId && x.sunday === sunday);
      need(r, "No such request.");
      Object.assign(r, patch);
    },
    async removeRequest(riderId, sunday) {
      const r = db.requests.find((x) => x.riderId === riderId && x.sunday === sunday);
      if (r) r.status = "cancelled";
    },
    async resolveAlert(id) { const a = db.alerts.find((x) => x.id === id); if (a) a.resolved = true; },

    // ---- services (leader changes to a day; everyone can read them)
    async services() { return fresh(db.services); },
    async saveService(row) {
      need(isLeader(), "Only the transport leader can change services.");
      db.services = db.services.filter((x) => x.date !== row.date).concat([fresh(row)]);
    },
    async deleteService(date) { need(isLeader(), "Only the transport leader can change services."); db.services = db.services.filter((x) => x.date !== date); },

    async locate(address, neighbourhood, geocoding) {
      return geocode(address, { neighbourhood, nominatimUrl: geocoding?.nominatimUrl, enabled: false });
    },
    _sundays: () => nextSundays(4, now()),
  };
}
