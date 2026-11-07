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
          let d = byId(a.driverId);
          const inVan = !!d.isVehicle;
          if (inVan) { const s = (db.vanShifts || []).find((x) => x.sunday === r.sunday && x.driverId); const h = s && byId(s.driverId); d = { ...d, name: h?.name || d.name, phone: h?.phone || null }; }
          rows.push({ ...base, status: "seated", driverName: d.name, driverPhone: d.phone, vehicle: d.vehicle, seats: a.seats ?? 1, trip: a.trip, pickupMin: a.pickupMin, readyByMin: a.readyByMin, arriveMin: a.arriveMin, inVan });
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
    async setVanOffer(sunday, ok, available) {
      const m = me();
      const ex = db.weeks.find((w) => w.driverId === m.id && w.sunday === sunday);
      if (ex) Object.assign(ex, { vanOk: !!ok });
      else db.weeks.push({ driverId: m.id, sunday, available: !!available, note: null, vanOk: !!ok });
    },
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
      const shift = (db.vanShifts || []).find((x) => x.sunday === sunday && x.driverId === m.id);
      const isVan = (id) => !!byId(id)?.isVehicle;
      return plan.assignments.filter((a) => a.driverId === m.id || (shift && isVan(a.driverId)))
        .sort((a, b) => isVan(a.driverId) - isVan(b.driverId) || a.trip - b.trip || a.order - b.order).map((a) => {
        const r = byId(a.riderId);
        const q = db.requests.find((x) => x.riderId === r.id && x.sunday === sunday);
        return { trip: a.trip, order: a.order, pickupMin: a.pickupMin, readyByMin: a.readyByMin, arriveMin: a.arriveMin, departMin: a.departMin ?? null,
          riderName: r.name, riderPhone: r.phone, address: r.address, neighbourhood: r.neighbourhood, lat: r.lat, lng: r.lng,
          minor: r.minor,
          riderNotes: r.notes, requestNote: q?.note ?? null, extraPeople: q?.extraPeople || 0, seats: a.seats ?? 1, partyTotal: 1 + (q?.extraPeople || 0), rideHome: !!q?.rideHome, cancelled: q?.status === "cancelled",
          inVan: isVan(a.driverId), vanStart: isVan(a.driverId) ? shift?.startFrom || "church" : null };
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
        unregistered: db.unregistered, signupIssues: db.signupIssues, vanShifts: db.vanShifts || [], vanLogs: [...(db.vanLogs || [])].reverse(), pushPeople: ["d-grace", "r-mary"] });
    },

    // ---- team (same rules as the database: only the supervisor; two leaders besides them at most)
    async logSignupIssue(category, message, role) { db.signupIssues.unshift({ at: now().toISOString(), email: me()?.email || "demo", category, message, role }); },
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
    // ---- church van (same rules as the database)
    async setChurchVan({ seats, address, lat, lng }) {
      need(isLeader(), "Only leaders can set up the church van.");
      need(seats >= 1 && seats <= 14, "Seats must be between 1 and 14 (not counting the driver).");
      let v = db.profiles.find((p) => p.isVehicle);
      if (!v) { v = { id: "van", userId: null, name: "Church van", role: "driver", isVehicle: true, status: "cleared", secondTrip: true, drivesEveryWeek: true, vehicle: "Church van", geoSource: "manual", licenceOk: true, insuranceOk: true }; db.profiles.push(v); }
      Object.assign(v, { seats, address: address || "Church", lat, lng });
      return v.id;
    },
    async setVanDriver(sunday, driverId, startFrom = "church") {
      need(isLeader(), "Only leaders can choose the van driver.");
      db.vanShifts = (db.vanShifts || []).filter((s) => s.sunday !== sunday);
      if (!driverId) return "ok";
      const d = byId(driverId);
      need(d && !d.isVehicle && d.status === "cleared", "Only a cleared driver can drive the church van.");
      db.vanShifts.push({ sunday, driverId, startFrom: startFrom === "home" ? "home" : "church" });
      return "ok";
    },
    // ---- van logbook (same rules as the database)
    async vanLogStart(sunday, v) {
      const m = me();
      need(isLeader() || (db.vanShifts || []).some((s) => s.sunday === sunday && s.driverId === m.id), "Only the person driving the church van that day can fill in its log.");
      need(v.startKm != null && v.startKm >= 0, "Enter the kilometres shown on the van before you drive.");
      db.vanLogs = db.vanLogs || [];
      need(!db.vanLogs.some((l) => l.sunday === sunday && l.driverId === m.id && !l.afterAt), "You already started the van log for this day. Fill in the \"after\" part when you park.");
      need(!v.damage || (v.damageNote || "").trim(), "Describe the damage you noticed (where and what).");
      const prev = [...db.vanLogs].reverse().find((l) => l.endKm != null);
      const l = { id: `vl${db.vanLogs.length + 1}`, sunday, driverId: m.id, driverName: m.name, beforeAt: now().toISOString(), startKm: v.startKm, fuelStart: v.fuel, checks: v.checks || {},
        damageBefore: !!v.damage, damageBeforeNote: v.damageNote || null, afterAt: null, endKm: null, fuelBought: false, receiptGiven: false, damageAfter: false };
      db.vanLogs.push(l);
      const alert = (message) => db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "van", sunday, driverId: m.id, riderId: null, resolved: false, message, createdAt: now().toISOString() });
      if (v.damage) alert(`${m.name} noticed damage on the church van BEFORE driving: ${v.damageNote.trim()}.${prev ? ` It was last driven by ${prev.driverName} on ${prev.sunday} (ended at ${prev.endKm} km), who reported ${prev.damageAfter ? "damage too" : "no damage"}.` : " There is no earlier trip in the log."}`);
      if (prev && v.startKm !== prev.endKm) alert(`Church van kilometres don't match: ${m.name} started at ${v.startKm} km, but the last trip (${prev.driverName}, ${prev.sunday}) ended at ${prev.endKm} km. ${v.startKm > prev.endKm ? `${v.startKm - prev.endKm} km were driven without a log entry.` : "Check the numbers with both drivers."}`);
      return l.id;
    },
    async vanLogEnd(id, v) {
      const m = me();
      const l = (db.vanLogs || []).find((x) => x.id === id);
      need(l, "That van log was not found.");
      need(l.driverId === m.id || isLeader(), "Only the person who started this log can finish it.");
      need(v.endKm != null && v.endKm >= l.startKm, `The kilometres at the end can't be less than at the start (${l.startKm}).`);
      need(v.endKm - l.startKm <= 1000, "That is over 1000 km for one day. Check the number.");
      need(!v.fuelBought || v.cost > 0, "Enter how much the fuel cost.");
      need(!v.damage || (v.damageNote || "").trim(), "Describe the damage (where and what happened).");
      Object.assign(l, { afterAt: now().toISOString(), endKm: v.endKm, fuelEnd: v.fuel, fuelBought: !!v.fuelBought, fuelLitres: v.fuelBought ? v.litres : null, fuelCost: v.fuelBought ? v.cost : null,
        receiptGiven: !!v.receiptGiven, damageAfter: !!v.damage, damageAfterNote: v.damageNote || null, notes: v.notes || null });
      const alert = (message) => db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "van", sunday: l.sunday, driverId: l.driverId, riderId: null, resolved: false, message, createdAt: now().toISOString() });
      if (v.damage) alert(`${l.driverName} reported damage to the church van after driving: ${v.damageNote.trim()}.`);
      if (v.fuelBought && !v.receiptGiven) alert(`${l.driverName} bought fuel for the church van ($${Number(v.cost).toFixed(2)}) and still has to give the receipt to the secretary.`);
      return "ok";
    },
    async vanLogReceipt(id) { const l = (db.vanLogs || []).find((x) => x.id === id); need(l, "That van log was not found."); l.receiptGiven = true; return "ok"; },
    async myVanLog(sunday) {
      const m = me();
      const logs = db.vanLogs || [];
      const mine = [...logs].reverse().find((l) => l.sunday === sunday && l.driverId === m.id) || null;
      const shift = (db.vanShifts || []).some((s) => s.sunday === sunday && s.driverId === m.id);
      if (!shift && !mine) return null;
      const prev = [...logs].reverse().find((l) => l.endKm != null && l !== mine);
      return { ...(mine || { id: null }), lastDriver: prev?.driverName || null, lastEndKm: prev?.endKm ?? null, lastSunday: prev?.sunday || null, lastDamage: !!prev?.damageAfter };
    },

    async savePlan(sunday, status, summary, assignments, waitlist) {
      need(isLeader(), "Only the transport leader can save a plan.");
      need(status !== "approved" || !assignments.some((a) => byId(a.driverId)?.isVehicle) || (db.vanShifts || []).some((s) => s.sunday === sunday && s.driverId),
        "Choose who drives the church van before approving.");
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
