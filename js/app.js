// The app shell: loads data, draws the right screen, and reacts to taps.
// Browser only. The logic it relies on lives in matching.js, planner.js and the stores.

import { CONFIG, IS_DEMO } from "./config.js";
import { createDemoStore } from "./store-demo.js";
import { peopleCsv, backupJson, stamp, download } from "./backup.js";
import { toISO, fmtDate, fmtMin, toMin } from "./dates.js";
const fmtMinLabel = (hhmm) => fmtMin(toMin(hhmm));
import { confirmAddress, suggestAddresses, refineSuggestions, normalizePhone, normalizePostal, isConfirmed, houseNumberOf, inSaskatoon, reverseLookup, locateStreet, nearestNeighbourhood, haversineKm } from "./geo.js";
import { driverIssue } from "./matching.js";
import { draftPlan, recompute, applyMove, reassignDriver, sundayPeople, rankHelpers } from "./planner.js";
import { driverAvailable, CONSENT_WORDING, isDriver } from "./models.js";
import { shell, landingView, signInView, demoPickerView, roleView, esc, remindGroups, REMIND } from "./views.js";
import { lastMinuteBroadcast } from "./texts.js";
import { setServices, upcomingDays, configFor, serviceFor } from "./services.js";
import { DEMO_CHURCH } from "./demo-data.js";
import { pushState, turnOn, turnOff, resync, askPermission } from "./push.js";
import { approvalPings } from "./notify.js";

const root = document.getElementById("app");
let store;

const S = {
  config: CONFIG, mode: IS_DEMO ? "demo" : "live",
  screen: "landing", session: null, me: null, tab: null,
  sundays: [], sunday: null, rides: [], weeks: [], routes: {},
  data: null, planView: null, planOpen: false, church: null, churchWarning: null, churchFound: null, formDraft: null,
  editing: null, busy: false, toast: "", error: "", signInSent: "", regRole: null, broadcast: "", help: null, helpAsks: [], services: [], editingService: null,
  now: new Date(), todayISO: "", demoPeople: null, appUrl: "", demoChurchLabel: DEMO_CHURCH.label,
};

// ---------------------------------------------------------------- drawing

function render() {
  S.now = new Date();
  S.todayISO = toISO(S.now);
  let inner;
  if (!S.session) {
    inner = S.screen === "picker" && S.demoPeople ? demoPickerView(S) : S.screen === "signin" ? signInView(S) : landingView(S);
  } else if (!S.me || S.screen === "loading") {
    inner = S.screen === "loading" ? `<p class="muted center">Loading…</p>` : roleView(S);
  } else {
    inner = roleView(S);
  }
  if (S.session && S.me && S.screen !== "loading") {
    const t = S.lastSync ? S.lastSync.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : "";
    inner = `<p class="sync small muted" aria-live="polite">${t ? `Up to date · ${t}` : "Up to date"} · checks every 30 seconds <button class="btn link" type="button" data-act="refresh-now">Refresh now</button></p>` + inner;
  }
  const y = window.scrollY;
  root.innerHTML = shell(S, inner);
  window.scrollTo(0, y);
  S.toast = "";
}

const say = (msg) => { S.toast = msg; };

// After anything that may notify someone, ask the sender to deliver what's waiting (a moment later,
// so several quick changes go out together). Clicks that only look at things don't.
const READ_ONLY = new Set(["home", "demo-start", "goto-signin", "reg-back", "reg-role", "signin-reset", "tab", "pick-sunday", "copy",
  "export-people", "export-backup", "view-plan", "hide-plan", "edit", "edit-cancel", "refresh-now", "push-later", "viewas", "signout"]);
let flushTimer = null;
function flushSoon() {
  if (!S.session || typeof store?.flushPush !== "function") return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => store.flushPush(), 1200);
}

async function guarded(fn) {
  S.error = "";
  S.busy = true;
  try { await fn(); }
  catch (err) { console.error(err); S.error = err?.message || String(err); }
  finally { S.busy = false; render(); }
}

// ---------------------------------------------------------------- loading

async function resolveChurch() {
  if (S.mode === "demo" && !(CONFIG.church.lat != null)) { S.church = { id: "church", ...DEMO_CHURCH }; S.churchWarning = null; return; }
  const c = CONFIG.church;
  if (c.lat != null && c.lng != null) { S.church = { lat: c.lat, lng: c.lng }; S.churchWarning = null; S.churchFound = { pinned: true, lat: c.lat, lng: c.lng }; return; }
  if (c.address) {
    // Only an exact house-number match is accepted. (Older versions cached a looser match.)
    const key = `cgc-church-v2:${c.address}`;
    try { const hit = JSON.parse(localStorage.getItem(key) || "null"); if (hit) { S.church = { lat: hit.lat, lng: hit.lng }; S.churchFound = hit; S.churchWarning = null; return; } } catch (_) { /* no storage */ }
    const g = await confirmAddress(c.address, { nominatimUrl: CONFIG.geocoding.nominatimUrl });
    if (g.ok) {
      S.church = { lat: g.lat, lng: g.lng }; S.churchWarning = null;
      S.churchFound = { pinned: false, address: g.address, postcode: g.postcode, neighbourhood: g.neighbourhood, lat: g.lat, lng: g.lng };
      try { localStorage.setItem(key, JSON.stringify(S.churchFound)); } catch (_) { /* ignore */ }
      return;
    }
    S.church = null; S.churchFound = null;
    S.churchWarning = `We couldn't find "${c.address}" exactly on the map (${g.reason}) Pin the church's latitude and longitude in js/config.js.`;
    return;
  }
  S.church = null;
  S.churchWarning = "Put the church's street address (or latitude and longitude) in js/config.js. Until then, plans can't be drafted.";
}

function excludedFor(sunday) {
  return S.data.profiles.filter(isDriver).map((d) => ({ name: d.name, reason: driverIssue({ ...d, available: driverAvailable(d, S.data.weeks, sunday) }, sunday) })).filter((e) => e.reason);
}

function planViewFromSaved() {
  const saved = S.data.plans[S.sunday];
  S.planView = saved ? { status: saved.status, assignments: saved.assignments, waitlist: saved.waitlist, trips: null, warnings: [], excluded: excludedFor(S.sunday), dirty: false, travelNote: "", travelSource: saved.summary?.travelSource, madeFor: { time: saved.summary?.serviceTime || CONFIG.service.time, arrive: saved.summary?.arriveBeforeMin ?? CONFIG.service.arriveBeforeMin } } : null;
}

/**
 * Keeps the plan in step with the requests, using the matching rules (the app's vision):
 * - no plan yet but people are asking -> make one;
 * - new requests -> place them; cancelled riders -> take them out. Everyone else stays put.
 * The result is NOT saved and NOT shared: the leader views it, then saves a draft or approves.
 * Never touches a plan the leader is in the middle of editing.
 */
async function autoUpdatePlan() {
  if (!S.data || !S.sunday || !S.church) return;
  const pv = S.planView;
  if (pv?.edited) return; // the leader is changing it by hand: leave it alone
  const svc = serviceFor(S.sunday);
  if (svc.cancelled) return; // no service that day
  if (pv && pv.madeFor && (pv.madeFor.time !== svc.time || pv.madeFor.arrive !== svc.arriveBeforeMin)) {
    // The leader changed the service time after this plan was made: same cars, new times.
    try {
      const res = await recompute({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), assignments: pv.assignments, waitlist: pv.waitlist });
      S.planView = { ...pv, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, dirty: true, edited: false,
        travelNote: res.travelNote, travelSource: res.travelSource, madeFor: { time: svc.time, arrive: svc.arriveBeforeMin },
        autoNote: `Times updated for the new service time (${fmtMinLabel(svc.time)}). Same cars and riders.` };
    } catch (err) { console.error(err); }
    return;
  }
  const asking = S.data.requests.filter((r) => r.sunday === S.sunday && r.status !== "cancelled");
  const askingIds = new Set(asking.map((r) => r.riderId));
  const name = (id) => S.data.profiles.find((p) => p.id === id)?.name || "a rider";
  let keep = [];
  let note;
  if (!pv) {
    if (!asking.length) return;
    note = `Plan made automatically from ${asking.length} request${asking.length > 1 ? "s" : ""}.`;
  } else {
    const placed = new Set([...pv.assignments.map((a) => a.riderId), ...pv.waitlist.map((w) => w.riderId)]);
    const added = asking.filter((r) => !placed.has(r.riderId)).map((r) => name(r.riderId));
    const gone = [...placed].filter((id) => !askingIds.has(id)).map(name);
    // A driver the leader has since cleared (and whose address is confirmed) can take people waiting.
    // Drivers who aren't cleared yet are never used.
    const inPlan = new Set(pv.assignments.map((a) => a.driverId));
    const drivers = sundayPeople(S.data, S.sunday).drivers;
    const fresh = pv.waitlist.length ? drivers.filter((d) => !driverIssue(d, S.sunday) && !inPlan.has(d.id)).map((d) => d.name) : [];
    // A driver in the plan who can't drive any more (said "I can't make it", paused, etc.): their riders are moved.
    const dropped = [...inPlan].filter((id) => { const d = drivers.find((x) => x.id === id); return !d || driverIssue(d, S.sunday); });
    if (!added.length && !gone.length && !fresh.length && !dropped.length) return;
    keep = pv.assignments.filter((a) => askingIds.has(a.riderId) && !dropped.includes(a.driverId));
    note = [added.length && `Added ${added.join(", ")}`, gone.length && `took out ${gone.join(", ")} (no longer asking)`,
      dropped.length && `moved ${dropped.map(name).join(", ")}'s riders to other drivers (${dropped.length > 1 ? "they can't" : "they can't"} drive)`,
      fresh.length && `offered seats with ${fresh.join(", ")} (newly cleared) to people waiting`].filter(Boolean).join("; ") + ". Everyone else stayed where they were.";
    note = note[0].toUpperCase() + note.slice(1);
  }
  try {
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), keep });
    adoptResult(res, pv?.status || "draft", { auto: true });
    S.planView.autoNote = note;
    S.planView.madeFor = { time: svc.time, arrive: svc.arriveBeforeMin };
  } catch (err) { console.error(err); }
}

async function load() {
  S.services = await store.services();
  setServices(S.services);
  S.sundays = upcomingDays(CONFIG.weeksAhead, new Date());
  const wasRole = S.me && `${S.me.role}/${!!S.me.isSupervisor}`;
  S.me = await store.getMe({ fresh: true });
  // Someone changed this person's team role (made them a leader, or moved them back).
  if (wasRole && S.me && wasRole !== `${S.me.role}/${!!S.me.isSupervisor}`) {
    S.tab = null; S.planView = null; S.data = null;
    S.roleNote = S.me.role === "leader" ? (S.me.isSupervisor ? "You are now the supervisor." : `You are now ${S.me.leaderTitle === "Assistant leader" ? "an assistant leader" : "a leader"}: the leader screens are open to you.`) : `Your role is now ${S.me.role}.`;
  }
  S.appUrl = location.href.split("#")[0].split("?")[0];
  if (!S.me) return;
  if (!S.push) {
    S.push = S.mode === "demo" ? null : await pushState().catch(() => "unsupported");
    try { S.pushLater = localStorage.getItem("cgc-push-later") === "1"; } catch { S.pushLater = false; }
    if (S.push === "on") resync(store); // this device follows whoever is signed in now
  }
  await resolveChurch();
  const defaults = { leader: "plan", driver: "sundays", rider: "rides" };
  if (!S.tab || (S.me.role === "leader" && !["plan", "people", "alerts", "texts", "services", "driving"].includes(S.tab)) ||
      (S.me.role === "driver" && !["sundays", "details"].includes(S.tab)) || (S.me.role === "rider" && !["rides", "details"].includes(S.tab))) S.tab = defaults[S.me.role];
  if (S.me.role === "rider") S.rides = await store.myRides();
  if (S.me.role === "driver" || S.me.role === "leader") S.helpAsks = await store.myHelpRequests();
  if (S.me.role === "driver") {
    S.weeks = await store.myWeeks();
    S.routes = {};
    for (const s of S.sundays) S.routes[s] = await store.myRoute(s);
  }
  if (S.me.role === "leader") {
    S.weeks = await store.myWeeks();
    S.routes = {};
    for (const s of S.sundays) S.routes[s] = await store.myRoute(s);
    S.data = await store.leaderData();
    S.sunday = S.sunday && S.sundays.includes(S.sunday) ? S.sunday : S.sundays[0];
    if (!S.planView || !S.planView.edited) planViewFromSaved();
    await autoUpdatePlan();
  }
}

async function reload() { await load(); S.lastSync = new Date(); }

// ---------------------------------------------------------------- reading forms

function readProfile(form) {
  const f = new FormData(form);
  const has = (n) => form.elements.namedItem(n) != null;
  const text = (n) => (f.get(n) || "").toString().trim() || null;
  const bool = (n) => f.get(n) === "on";
  const num = (n) => { const v = text(n); return v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v); };
  const out = { name: text("name"), phone: text("phone"), address: text("address"), postalCode: text("postalCode"), neighbourhood: text("neighbourhood"), minor: bool("minor"), notes: text("notes") };
  // Filled in when the person picks a suggestion (cleared again if they edit the address).
  out.picked = text("pickedAddress") ? { address: text("pickedAddress"), lat: num("pickedLat"), lng: num("pickedLng") } : null;
  // A pin the person placed on their house (phone location or by hand).
  out.pin = num("pinLat") != null && num("pinLng") != null ? { lat: num("pinLat"), lng: num("pinLng"), how: text("pinHow") } : null;
  if (has("role")) out.role = text("role");
  if (has("alsoDrives")) out.status = bool("alsoDrives") ? "cleared" : "none";
  if (has("seats")) Object.assign(out, { seats: Number(f.get("seats")) || 0, vehicle: text("vehicle"), drivesEveryWeek: bool("drivesEveryWeek"), secondTrip: bool("secondTrip") });
  if (has("priority")) out.priority = bool("priority");
  if (has("status")) Object.assign(out, { status: text("status"), licenceOk: bool("licenceOk"), insuranceOk: bool("insuranceOk"), policeCheckExpiry: text("policeCheckExpiry") });
  return out;
}

/**
 * Checks a profile before saving. Name, phone, home address and postal code are required.
 * The address must be confirmed on the map down to the house number; only then is it saved
 * with a location (geo_source "verified") and used for matching.
 * strict = true for people registering themselves: an unconfirmed address can't be saved.
 * The leader (strict = false) may save it anyway; that person is then never matched until fixed.
 * Returns { patch, warning }.
 */
async function checkProfile(raw, previous = {}, { strict }) {
  const { picked, pin, ...patch } = raw;
  if (!patch.name) throw new Error("Please enter the full name.");
  const phone = normalizePhone(patch.phone);
  if (!phone) throw new Error("Please enter a 10-digit phone number, for example 306-555-0142.");
  patch.phone = phone;
  if (!patch.address) throw new Error("Please enter the home address, starting with the house number.");
  const typedPostal = patch.postalCode ? normalizePostal(patch.postalCode) : null;
  if (patch.postalCode && !typedPostal) throw new Error("That postal code doesn't look right. It should look like S7N 0A1.");

  const unchanged = patch.address === previous.address && isConfirmed(previous);
  let warning = "";
  if (pin) {
    // The person put a pin on their house: their typed address is kept, the pin gives the location.
    if (!houseNumberOf(patch.address)) throw new Error("Please type the address starting with the house number (for example 1666 Stonebridge Blvd), so the driver knows which door.");
    if (!inSaskatoon(pin.lat, pin.lng)) throw new Error("The pin is outside Saskatoon. Move it onto the house and try again.");
    Object.assign(patch, { lat: pin.lat, lng: pin.lng, geoSource: pin.how === "gps" ? "gps" : "pin" });
    if (!patch.neighbourhood) patch.neighbourhood = nearestNeighbourhood(pin.lat, pin.lng);
  } else if (unchanged) {
    Object.assign(patch, { lat: previous.lat, lng: previous.lng, geoSource: previous.geoSource, neighbourhood: previous.neighbourhood || patch.neighbourhood });
  } else {
    const g = await confirmAddress(patch.address, { nominatimUrl: CONFIG.geocoding.nominatimUrl, postcode: typedPostal });
    // A picked suggestion that the final check can't repeat is still trusted: it came from the map with a house number.
    const ok = g.ok ? g : (picked && picked.address === patch.address && picked.lat != null ? { ok: true, address: picked.address, lat: picked.lat, lng: picked.lng, postcode: null, neighbourhood: null } : null);
    if (ok) {
      Object.assign(patch, { address: ok.address, lat: ok.lat, lng: ok.lng, geoSource: "verified" });
      if (ok.neighbourhood) patch.neighbourhood = ok.neighbourhood;
      if (!typedPostal && ok.postcode) patch.postalCode = ok.postcode;
    } else if (strict) {
      throw new Error(`${g.reason} If your home isn't on the map yet, tap "Place a pin on the map" under the address.`);
    } else {
      Object.assign(patch, { lat: null, lng: null, geoSource: "none" });
      warning = ` Address not confirmed (${g.reason}) This person won't be matched until it is.`;
    }
  }
  const postal = normalizePostal(patch.postalCode);
  if (!postal) throw new Error("Please enter the postal code, for example S7N 0A1.");
  patch.postalCode = postal;
  return { patch, warning };
}

// ---------------------------------------------------------------- plan helpers

function planSummary() {
  const c = configFor(S.sunday);
  return { travelSource: S.planView.travelSource || null, travelNote: S.planView.travelNote || "", savedFrom: "app", serviceTime: c.service.time, arriveBeforeMin: c.service.arriveBeforeMin };
}

async function persistPlan(status) {
  const pv = S.planView;
  const before = S.data?.plans?.[S.sunday] || null;
  await store.savePlan(S.sunday, status, planSummary(), pv.assignments.map((a) => ({ riderId: a.riderId, driverId: a.driverId, trip: a.trip, order: a.order ?? 0, seats: a.seats ?? 1, pickupMin: a.pickupMin ?? null, readyByMin: a.readyByMin ?? null, arriveMin: a.arriveMin ?? null, departMin: a.departMin ?? null })), pv.waitlist);
  if (status === "approved") {
    // Ping the people whose ride changed (only those with notifications on receive it).
    try {
      const pings = approvalPings({ before, after: pv, sunday: S.sunday, profilesById: new Map(S.data.profiles.map((p) => [p.id, p])) });
      await store.queuePush(pings);
    } catch (err) { console.warn("Couldn't queue notifications", err); }
  }
  S.planView = null;
  await reload();
}

function adoptResult(res, status, { auto = false } = {}) {
  const svc = serviceFor(S.sunday);
  S.planView = { madeFor: { time: svc.time, arrive: svc.arriveBeforeMin }, edited: !auto, status, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, excluded: res.excludedDrivers || excludedFor(S.sunday), dirty: true, travelNote: res.travelNote, travelSource: res.travelSource };
}

function needChurch() { if (!S.church) throw new Error(S.churchWarning || "The church location isn't set."); }

// ---------------------------------------------------------------- actions

const actions = {
  home() { S.screen = "landing"; },
  "demo-start"() { S.screen = "picker"; },
  "goto-signin"() { S.screen = "signin"; },
  "reg-back"() { S.regRole = null; S.formDraft = null; },
  async "export-people"() { download(`cgc-rides-people-${stamp()}.csv`, "text/csv", peopleCsv(S.data.profiles || [])); say("People list downloaded. Keep it private."); },
  async "export-backup"() { const t = await store.exportAll(); download(`cgc-rides-backup-${stamp()}.json`, "application/json", backupJson(t)); say("Backup downloaded. Keep it private."); },
  "reg-role"(d) { S.regRole = d.role === "driver" ? "driver" : "rider"; },
  "signin-reset"() { S.signInSent = ""; },
  async viewas(d) { store.viewAs(d.id); S.session = store.session(); S.tab = null; S.sunday = null; S.planView = null; S.editing = null; await reload(); say(`Viewing as ${S.me?.name}`); },
  async signout() { await store.signOut(); S.session = null; S.me = null; S.screen = "landing"; S.tab = null; S.planView = null; S.regRole = null; },
  tab(d) { S.tab = d.tab; S.editing = null; S.formDraft = null; S.remindResult = null; if (S.pushNote?.kind !== "wait") S.pushNote = null; },
  async "pick-sunday"(d) {
    if (d.sunday === S.sunday) return;
    if (S.planView?.dirty && S.planView.edited && !confirm("You have unsaved changes to this plan. Switch anyway?")) return;
    S.sunday = d.sunday; S.planOpen = false; planViewFromSaved(); await autoUpdatePlan();
  },
  copy(d) { return copyText(d.text).then(() => say("Copied. Paste it into your message.")); },

  // rider
  async "cancel-ride"(d) { if (!confirm("Tell the team you can't make it on " + fmtDate(d.sunday) + "?")) return; await store.cancelRide(d.sunday); await reload(); say("Okay, we've let the team know."); },
  async "consent-on"() { await store.giveConsent(CONSENT_WORDING); await reload(); say("Thank you. We'll text you about your rides."); },
  async "consent-off"() { await store.withdrawConsent(); await reload(); say("Texts turned off."); },

  // driver
  async "toggle-avail"(d) { await store.setAvailability(d.sunday, d.to === "yes"); await reload(); },
  async "cant-make-it"(d) {
    if (!confirm("Tell the leader you can't drive on " + fmtDate(d.sunday) + "? Your riders will be moved to other drivers.")) return;
    await store.cantMakeIt(d.sunday); await reload(); say("The leader has been told. Thank you for letting us know.");
  },

  // leader
  async draft() {
    needChurch();
    if (S.planView && !confirm("Start the plan over from scratch? Any changes you made by hand will be lost.")) return;
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday) });
    adoptResult(res, "draft");
    S.planOpen = true;
    say(`New plan ready: ${res.assignments.length} seated, ${res.waitlist.length} waiting. Review it, then save or approve.`);
  },
  async "view-plan"() {
    if (!S.planView) {
      needChurch();
      const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday) });
      adoptResult(res, "draft", { auto: true });
      say(`Plan ready: ${res.assignments.length} seated, ${res.waitlist.length} waiting.`);
    }
    S.planOpen = true;
  },
  "hide-plan"() { S.planOpen = false; },
  async "add-new"() {
    needChurch();
    const current = S.planView;
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), keep: current.assignments });
    adoptResult(res, current.status);
    S.planOpen = true;
    say("New requests added. Everyone else stayed where they were. Review, then save or approve.");
  },
  async "save-draft"() { await persistPlan("draft"); say("Draft saved. Drivers and riders can't see it yet."); },
  async approve() {
    if (S.planView.warnings?.some((w) => w.code === "over_seats" || w.code === "driver_issue")) throw new Error("Fix the warnings about seats or driver clearance before approving.");
    if (S.planView.warnings?.some((w) => w.code === "no_location")) throw new Error("Someone in a car has no confirmed address, so their pickup time is unknown. Move them to the waiting list or confirm their address, then approve.");
    if (S.planView.travelSource === "estimate" && CONFIG.routing.enabled && !confirm("Real road times couldn't be loaded, so these times are rough estimates (with a bigger safety margin). Press Cancel and then Redraft to try again, or OK to approve anyway.")) return;
    await persistPlan("approved");
    say("Approved. Drivers and riders can now see their details. Copy their messages from the Texts tab, then mark any alerts done.");
  },
  async reassign(d) {
    needChurch();
    if (S.sunday !== d.sunday) { S.sunday = d.sunday; planViewFromSaved(); }
    else if (!S.planView) planViewFromSaved();
    const current = S.planView;
    if (!current) throw new Error("There's no plan for that Sunday yet. Draft one first.");
    const res = await reassignDriver({ data: S.data, sunday: d.sunday, church: S.church, config: configFor(S.sunday), current, driverId: d.driver });
    S.data = { ...S.data, weeks: res.weeks };
    adoptResult(res, current.status);
    await store.resolveAlert(d.alert);
    S.data.alerts = S.data.alerts.map((a) => (a.id === d.alert ? { ...a, resolved: true } : a));
    S.tab = "plan";
    say(`Riders moved. ${res.waitlist.length ? res.waitlist.length + " could not be placed (see waiting list). " : ""}Review, then save.`);
  },
  async "split-ok"(d) {
    needChurch();
    const rid = d.rider;
    await store.updateRequest(rid, S.sunday, { canSplit: true });
    S.data = { ...S.data, requests: S.data.requests.map((q) => (q.riderId === rid && q.sunday === S.sunday ? { ...q, canSplit: true } : q)) };
    const current = S.planView;
    const keep = current.assignments.filter((a) => a.riderId !== rid);
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), keep });
    adoptResult(res, current.status);
    say("Re-placed that group across cars. Everyone else stayed where they were. Review, then save.");
  },
  async resolve(d) { await store.resolveAlert(d.id); await reload(); },
  async "refresh-now"() { await refreshNow({ manual: true }); },

  // services (leader)
  "service-edit"(d) { S.editingService = d.date; S.formDraft = null; },
  "service-new"() { S.editingService = "new"; S.formDraft = null; },
  "service-close"() { S.editingService = null; },
  async "service-off"(d) {
    if (!confirm(`Mark ${fmtDate(d.date, { weekday: "long", month: "long", day: "numeric" })} as no service? Riders won't be able to ask for a ride that day.`)) return;
    const cur = S.services.find((x) => x.date === d.date);
    const before = serviceFor(d.date);
    await store.saveService({ date: d.date, title: cur?.title || "", time: cur?.time || CONFIG.service.time, arriveBeforeMin: cur?.arriveBeforeMin ?? CONFIG.service.arriveBeforeMin, cutoff: cur?.cutoff || null, cancelled: true, note: cur?.note || "" });
    await reload(); await unshareIfChanged(d.date, before);
    say("Marked as no service. Send the announcement from the Texts tab so people know.");
  },
  async "service-reset"(d) {
    const sunday = new Date(d.date + "T12:00:00").getDay() === 0;
    if (!confirm(sunday ? "Put this Sunday back to the usual service time?" : "Remove this special service? Anyone who asked for a ride for it will no longer see it.")) return;
    const before = serviceFor(d.date);
    await store.deleteService(d.date); S.editingService = null; await reload();
    const taken = await unshareIfChanged(d.date, before);
    if (taken) { say("Back to the usual time. The plan for that day went back to a draft with new times: check it and approve it again."); return; }
    say(sunday ? "Back to the usual Sunday service." : "Special service removed.");
  },
  async "help-answer"(d) {
    const r = await store.answerHelp(d.id, d.answer);
    await reload();
    say({ accepted: "Thank you! The ride is yours. The address and time are below.", taken: "Thank you! Another driver said yes first, so this ride is covered.",
      cancelled: "This request was cancelled by the transport leader.", noted: "Thanks for letting us know." }[r] || "Answer saved.");
  },
  async "help-cancel"(d) {
    if (!confirm("Cancel this last-minute request? Drivers will no longer see it.")) return;
    await store.cancelHelpRequest(d.id); await reload(); say("Request cancelled.");
  },
  /** From a "rider cancelled" alert: open that Sunday's plan, already updated without them, ready to approve. */
  async "alert-plan"(d) {
    S.sunday = d.sunday; S.planView = null; planViewFromSaved(); await autoUpdatePlan();
    await store.resolveAlert(d.alert);
    S.data.alerts = S.data.alerts.map((a) => (a.id === d.alert ? { ...a, resolved: true } : a));
    S.tab = "plan"; S.planOpen = true;
    say("The plan is updated without them. Check it, then tap Approve & share. Copy the new pickup list from the Texts tab.");
  },
  /** Puts a last-minute rider straight into a driver's car (trip 1), then shows the plan to save or approve. */
  async "help-assign"(d) {
    needChurch();
    const seats = Math.max(1, Number(d.seats) || 1);
    const req = S.data.requests.find((q) => q.riderId === d.rider && q.sunday === S.sunday && q.status !== "cancelled");
    if (!req) { await store.addRequest(d.rider, S.sunday, { extraPeople: seats - 1 }); await reload(); }
    if (!S.planView) { await autoUpdatePlan(); }
    if (!S.planView) throw new Error("There's no plan for this day yet. Open the Plan tab first.");
    const inCar = S.planView.assignments.find((a) => a.riderId === d.rider);
    const from = inCar ? `${inCar.driverId}|${inCar.trip || 1}` : "wait";
    const moved = applyMove({ assignments: S.planView.assignments, waitlist: S.planView.waitlist }, d.rider, `${d.driver}|1`, from);
    const res = await recompute({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), ...moved });
    S.planView = { ...S.planView, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, dirty: true, edited: true, travelNote: res.travelNote, travelSource: res.travelSource };
    S.tab = "plan"; S.planOpen = true; S.help = null;
    say("Added to the car. Check the times, then tap Approve & share to send everyone the update.");
  },
  edit(d) { S.editing = d.id; S.formDraft = null; },
  "edit-cancel"() { S.editing = null; S.formDraft = null; },
  async "team-role"(d) {
    const p = S.data.profiles.find((x) => x.id === d.id);
    if (!p) return;
    const words = { leader: "Leader", assistant: "Assistant leader", driver: "a driver", rider: "a rider" }[d.role];
    const back = d.role === "driver" || d.role === "rider";
    if (!confirm(back ? `Move ${p.name} back to ${words}? They will no longer see the leader screens.` : `Make ${p.name} ${words}?`)) return;
    await store.setTeamRole(d.id, d.role);
    await reload();
    say(back ? `${p.name} is now ${words}.` : `${p.name} is now ${words}. They'll see the leader screens next time they open the app.`);
  },
  async "push-on"() {
    if (S.push === "ios-install") return;
    const asking = askPermission(); // straight from the tap, or the phone won't ask
    S.pushNote = { kind: "wait", text: "Your phone should now ask whether to allow notifications. Tap Allow. Nothing popped up? Look for a bell or 🔒 icon beside the web address and allow notifications there." };
    render();
    try {
      S.push = await turnOn(store, asking);
    } catch (err) {
      S.pushNote = { kind: "err", text: `Notifications aren't on yet. ${err.message}` };
      return;
    }
    if (S.push === "on") {
      S.pushNote = { kind: "wait", text: "✓ This phone is set up. Sending a test notification…" };
      render();
      const r = await store.pushTest().catch(() => null);
      S.pushNote = r?.sent
        ? { kind: "ok", text: "✓ Notifications are on. We just sent a test notification to this phone; it should appear in a few seconds." }
        : { kind: "warn", text: "✓ This phone is set up for notifications, but the test message couldn't be sent just now. You'll still get real ones; if they never come, tell the transport leader." };
    } else if (S.push === "blocked") {
      S.pushNote = { kind: "err", text: "Notifications were blocked on this phone. To allow them: tap the 🔒 (or settings) icon beside the web address → Permissions (or Site settings) → Notifications → Allow. Then come back and tap Allow notifications again." };
    } else {
      S.pushNote = { kind: "warn", text: "The question was closed before you answered, so notifications aren't on yet. Tap Allow notifications again, then tap Allow. Still nothing? Tap the 🔒 icon beside the web address → Permissions → Notifications → Allow." };
    }
  },
  async remind(d) {
    const list = remindGroups(S)[d.group] || [];
    if (!list.length) return;
    const m = REMIND[d.group];
    if (!confirm(`Send "${m.title}" to ${list.length} ${list.length === 1 ? "person" : "people"}?`)) return;
    const sent = await store.queuePush(list.map((p) => ({ profileId: p.id, title: m.title, body: m.text, tag: `remind-${d.group}` })));
    await store.flushPush();
    const on = new Set(S.data.pushPeople || []);
    S.remindResult = { group: d.group, sent: Number(sent) || 0, others: list.filter((p) => !on.has(p.id)) };
  },
  async "push-off"() { S.push = await turnOff(store); say("Notifications turned off for this device."); },
  "push-later"() { S.pushLater = true; try { localStorage.setItem("cgc-push-later", "1"); } catch {} say("No problem. You can turn notifications on any time from My details."); },
  async "remove-person"(d) {
    const p = S.data.profiles.find((x) => x.id === d.id);
    if (!p) return;
    if (!confirm(`Remove ${p.name}? This deletes them with their requests, availability and rides, and cannot be undone. Any plan they are in goes back to a draft.`)) return;
    const res = await store.removePerson(d.id);
    S.editing = null; S.planView = null; await reload();
    say(`${res?.removed || p.name} was removed.` + (res?.plansReopened ? ` ${res.plansReopened} plan(s) went back to draft: please check and approve again.` : ""));
  },
};

/** Last-minute help: rank the closest cleared drivers for one rider (registered, or a typed address). */
async function findHelpers(form) {
  needChurch();
  const f = new FormData(form);
  const seats = Math.max(1, Math.min(10, Number(f.get("helpSeats")) || 1));
  const typed = (f.get("address") || "").toString().trim();
  let rider;
  if (typed) {
    const name = (f.get("helpName") || "").toString().trim() || "The rider";
    const picked = f.get("pickedAddress") ? { address: f.get("pickedAddress").toString(), lat: Number(f.get("pickedLat")), lng: Number(f.get("pickedLng")) } : null;
    const g = await confirmAddress(typed, { nominatimUrl: CONFIG.geocoding.nominatimUrl });
    const ok = g.ok ? g : (picked && picked.address === typed ? { ...picked, neighbourhood: null } : null);
    const phone = (f.get("helpPhone") || "").toString().trim();
    if (phone && !normalizePhone(phone)) throw new Error("That phone number doesn't look right. Use 10 digits, e.g. 306-555-0142, or leave it empty.");
    S.help = { sunday: S.sunday, riderId: null, name, seats, phone: phone ? normalizePhone(phone) : null, newRider: { name, address: typed, phone } };
    if (!ok) throw new Error(g.reason);
    rider = { lat: ok.lat, lng: ok.lng, geoSource: "verified" };
    S.help.neighbourhood = ok.neighbourhood || null;
    S.help.place = { address: ok.address || typed, lat: ok.lat, lng: ok.lng, neighbourhood: ok.neighbourhood || null, postalCode: ok.postcode || null };
  } else {
    throw new Error("Type the rider's name and where to pick them up (pick the address from the list).");
  }
  const assignments = S.planView?.assignments || S.data.plans[S.sunday]?.assignments || [];
  S.help.result = await rankHelpers({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), rider, seats, assignments });
}

/**
 * If a day's start time (or arrive-early minutes) changes, or it's called off, an approved plan
 * for that day goes back to a draft, so nobody is shown a pickup time worked out for the old time.
 * The plan re-times itself; the leader approves it again. Returns true if a plan was taken back.
 */
async function unshareIfChanged(date, before) {
  const after = serviceFor(date);
  const plan = S.data?.plans?.[date];
  if (!plan || plan.status !== "approved") return false;
  if (before.time === after.time && before.arriveBeforeMin === after.arriveBeforeMin && before.cancelled === after.cancelled) return false;
  await store.savePlan(date, "draft", plan.summary || {}, plan.assignments, plan.waitlist);
  if (S.sunday === date) S.planView = null;
  await reload();
  return true;
}

/** Saves a changed Sunday or a special service from the Services tab. */
async function saveServiceForm(form) {
  const f = new FormData(form);
  const v = (n) => (f.get(n) || "").toString().trim();
  const date = v("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Choose the date of the service.");
  if (date < toISO(new Date())) throw new Error("That date has already passed.");
  const time = v("time");
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Enter the time the service starts.");
  const sunday = new Date(date + "T12:00:00").getDay() === 0;
  const title = v("title");
  if (!sunday && !title) throw new Error("Give the special service a name, for example Christmas Eve service.");
  let cutoff = null;
  if (v("cutoffDate") || v("cutoffTime")) {
    if (!v("cutoffDate") || !v("cutoffTime")) throw new Error("For the request cutoff, enter both a date and a time (or leave both empty for noon the day before).");
    const c = new Date(`${v("cutoffDate")}T${v("cutoffTime")}:00`);
    if (c >= new Date(`${date}T${time}:00`)) throw new Error("The request cutoff has to be before the service starts.");
    cutoff = c.toISOString();
  }
  const arrive = Math.max(0, Math.min(90, Number(v("arriveBefore")) || 0));
  const before = serviceFor(date);
  await store.saveService({ date, title, time, arriveBeforeMin: arrive, cutoff, cancelled: false, note: v("note") });
  S.editingService = null;
  await reload();
  const taken = await unshareIfChanged(date, before);
  say(`Saved. Everyone's dashboard now shows it. Send the announcement from the Texts tab.${taken ? " The plan for that day went back to a draft with new times: check it and approve it again." : ""}`);
}

/** Sends the last-minute request to the ticked drivers' dashboards. The first to say yes gets the ride. */
async function askInApp(form) {
  const h = S.help;
  if (!h?.result || !h.place) throw new Error("Find the closest drivers first.");
  const ids = new FormData(form).getAll("askDriver").map(String);
  if (!ids.length) throw new Error("Tick at least one driver to ask.");
  const asks = h.result.list.filter((x) => ids.includes(x.driver.id)).map((x) => ({ driverId: x.driver.id, awayMin: x.awayMin }));
  await store.createHelpRequest({ sunday: h.sunday, riderName: h.name, riderPhone: h.phone, ...h.place, seats: h.seats, pickupMin: h.result.pickupMin }, asks);
  S.help = null;
  await reload();
  say(`Asked ${asks.length} driver${asks.length > 1 ? "s" : ""} in the app. Copy each one the short text below so they know to look. The first to say yes gets the ride.`);
}

async function onMove(el) {
  if (!el.value) return;
  needChurch();
  const moved = applyMove({ assignments: S.planView.assignments, waitlist: S.planView.waitlist }, el.dataset.rider, el.value, el.dataset.from);
  const res = await recompute({ data: S.data, sunday: S.sunday, church: S.church, config: configFor(S.sunday), ...moved });
  S.planView = { ...S.planView, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, dirty: true, edited: true, travelNote: res.travelNote, travelSource: res.travelSource };
}

async function onSubmit(form) {
  const kind = form.dataset.form;
  if (kind === "signin") { const email = new FormData(form).get("email").toString().trim(); await store.signIn(email); S.signInSent = email; return; }
  if (kind === "code") { await store.verifyCode(S.signInSent, new FormData(form).get("code").toString().trim()); S.signInSent = ""; S.session = store.session(); await reload(); return; }
  if (kind === "request") { const f = new FormData(form); await store.requestRide(form.dataset.sunday, { rideHome: f.get("rideHome") === "on", note: (f.get("note") || "").toString().trim() || null, extraPeople: Math.max(0, Math.min(10, Number(f.get("extraPeople")) || 0)), canSplit: f.get("canSplit") === "on" }); await reload(); say("Request sent. We'll confirm your driver after requests close."); return; }
  if (kind === "help") { await findHelpers(form); return; }
  if (kind === "service") { await saveServiceForm(form); return; }
  if (kind === "help-ask") { await askInApp(form); return; }
  if (kind === "team-add") {
    const f = new FormData(form);
    const p = S.data.profiles.find((x) => x.id === f.get("person"));
    if (!p) throw new Error("Choose a person first.");
    const role = f.get("role") === "assistant" ? "assistant" : "leader";
    const words = role === "leader" ? "Leader" : "Assistant leader";
    if (!confirm(`Make ${p.name} ${words}? They'll be able to see everyone's details and manage rides.`)) return;
    await store.setTeamRole(p.id, role);
    await reload();
    say(`${p.name} is now ${words}. They'll see the leader screens next time they open the app.`);
    return;
  }
  if (kind === "handover") {
    const f = new FormData(form);
    const p = S.data.profiles.find((x) => x.id === f.get("person"));
    if (!p) throw new Error("Choose who to hand over to.");
    const typed = String(f.get("confirmName") || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (typed !== p.name.trim().toLowerCase().replace(/\s+/g, " ")) throw new Error(`To confirm, type ${p.name} exactly as shown.`);
    const myRole = String(f.get("myRole") || "rider");
    if (!confirm(`Hand the supervisor role to ${p.name}? Only they will be able to change the team after this.`)) return;
    await store.handOverSupervisor(p.id, myRole);
    S.tab = null; S.planView = null;
    await reload();
    say(`${p.name} is now the supervisor. Thank you for leading!`);
    return;
  }
  if (kind === "profile") {
    const leaderEditing = S.me?.role === "leader" && S.editing;
    const raw = readProfile(form);
    S.formDraft = raw; // keeps what was typed if something needs fixing
    if (leaderEditing) {
      const existing = S.editing === "new" ? {} : S.data.profiles.find((p) => p.id === S.editing);
      const { patch, warning } = await checkProfile(raw, existing, { strict: false });
      const id = await store.saveProfile({ ...(existing.id ? { id: existing.id } : {}), ...patch });
      const f = new FormData(form);
      if (S.editing === "new") {
        if (f.get("needsRide") === "on") await store.addRequest(id, S.sunday, { extraPeople: Math.max(0, Math.min(10, Number(f.get("extraPeople")) || 0)), canSplit: f.get("canSplit") === "on" });
        if (f.get("consentByPhone") === "on") await store.giveConsent(CONSENT_WORDING + " (agreed by phone, recorded by the leader)", id);
      }
      S.editing = null; S.formDraft = null; await reload(); say("Saved." + warning); return;
    }
    const registering = !S.me;
    const { patch } = await checkProfile(raw, S.me || {}, { strict: true });
    if (!registering) delete patch.role;
    S.me = await store.saveMyProfile(patch);
    S.formDraft = null;
    if (registering) { S.tab = null; S.regRole = null; }
    await reload(); say(registering ? `You're registered. Your address is confirmed${patch.neighbourhood ? ` (${patch.neighbourhood})` : ""}.` : "Saved.");
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
}

// ---------------------------------------------------------------- wiring

// ---------------------------------------------------------------- address suggestions
// Works on the form in place (no redraw), so typing and focus are never interrupted.

let suggestTimer = null;
let suggestSeq = 0;
const field = (form, n) => form.elements.namedItem(n);
function setPicked(form, s) {
  field(form, "pickedAddress").value = s ? s.address : "";
  field(form, "pickedLat").value = s ? s.lat : "";
  field(form, "pickedLng").value = s ? s.lng : "";
}
// Speed: answers are remembered for the visit; the list on screen is narrowed instantly while a
// fresh search runs; an outdated search is cancelled; the connection is opened on first focus.
const suggestCache = new Map(); // typed text -> suggestions
let suggestAbort = null;
let lastList = [];
let warmed = false;
function showSuggestions(box, list, searching) {
  box._list = list;
  const rows = list.map((s, i) => `<button type="button" class="suggestion" role="option" data-i="${i}"><strong>${esc(s.address)}</strong><small>${esc([s.neighbourhood, s.postcode, "Saskatoon"].filter(Boolean).join(" · "))}</small></button>`).join("");
  box.innerHTML = rows + (searching
    ? `<div class="none searching">Searching…</div>`
    : list.length ? "" : `<div class="none">No exact match yet. Keep typing the full address with the house number, e.g. 1666 Stonebridge Blvd.</div>`);
  box.hidden = false;
}
root.addEventListener("focusin", (e) => {
  if (warmed || !(e.target instanceof HTMLInputElement) || e.target.name !== "address") return;
  warmed = true; // opens the connection now, so the first real search answers faster
  fetch(`${CONFIG.geocoding.photonUrl}/api/?q=Saskatoon&limit=1`).catch(() => {});
});
root.addEventListener("input", (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.name !== "address" || !input.form?.querySelector(".suggest")) return;
  const form = input.form;
  const box = form.querySelector(".suggest");
  const status = form.querySelector(".addr-status");
  setPicked(form, null);
  status.innerHTML = field(form, "pinLat")?.value
    ? '<span class="ok-text">📍 Your pin is still on the house.</span> Just make sure the address starts with the house number.'
    : '<span class="warn-text">Not confirmed yet.</span> Pick your address from the list. Not there? Use one of the options below.';
  clearTimeout(suggestTimer);
  const q = input.value;
  const key = q.trim().toLowerCase().replace(/\s+/g, " ");
  const seq = ++suggestSeq;
  if (key.length < 4 || !/\d/.test(key)) { box.hidden = true; box.innerHTML = ""; return; }
  if (suggestCache.has(key)) { lastList = suggestCache.get(key); showSuggestions(box, lastList, false); return; }
  showSuggestions(box, refineSuggestions(lastList, q), true); // instant, from what's already on screen
  suggestTimer = setTimeout(async () => {
    if (suggestAbort) suggestAbort.abort();
    suggestAbort = typeof AbortController === "function" ? new AbortController() : null;
    const list = await suggestAddresses(q, { photonUrl: CONFIG.geocoding.photonUrl, signal: suggestAbort?.signal });
    suggestCache.set(key, list);
    if (seq !== suggestSeq) return; // they've typed more since; that search will show
    lastList = list;
    showSuggestions(box, list, false);
  }, 180);
});
// Close the list when the person moves on (after a moment, so a tap on a suggestion still lands).
root.addEventListener("focusout", (e) => {
  if (!(e.target instanceof HTMLInputElement) || e.target.name !== "address") return;
  const box = e.target.form?.querySelector(".suggest");
  if (box) setTimeout(() => { if (!box.contains(document.activeElement)) box.hidden = true; }, 250);
});

function pickSuggestion(btn) {
  const box = btn.closest(".suggest");
  const s = box._list?.[Number(btn.dataset.i)];
  const form = btn.closest("form");
  if (!s || !form) return;
  field(form, "address").value = s.address;
  setPicked(form, s);
  if (field(form, "pinLat")) { field(form, "pinLat").value = ""; field(form, "pinLng").value = ""; field(form, "pinHow").value = ""; }
  if (s.postcode && field(form, "postalCode")) field(form, "postalCode").value = s.postcode;
  if (s.neighbourhood && field(form, "neighbourhood")) { field(form, "neighbourhood").value = s.neighbourhood; form.querySelector(".hood-name").textContent = s.neighbourhood; }
  form.querySelector(".addr-status").innerHTML = `<span class="ok-text">✓ Found on the map${s.neighbourhood ? ` · ${esc(s.neighbourhood)}` : ""}</span>${s.postcode ? "" : " Please type your postal code below."}`;
  box.hidden = true;
  (field(form, "postalCode") || field(form, "helpSeats") || field(form, "address")).focus();
}

root.addEventListener("click", (e) => {
  const sug = e.target.closest(".suggestion");
  if (sug) { e.preventDefault(); pickSuggestion(sug); return; }
  const pinBtn = e.target.closest("[data-pin]");
  if (pinBtn) { e.preventDefault(); onPin(pinBtn); return; }
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT") return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); guarded(() => fn(el.dataset)).then(() => { if (!READ_ONLY.has(el.dataset.act)) flushSoon(); }); }
});
root.addEventListener("change", (e) => {
  const el = e.target.closest("[data-act-change]");
  if (!el) return;
  const act = el.dataset.actChange;
  if (act === "move") guarded(() => onMove(el));
  if (act === "viewas") guarded(() => actions.viewas({ id: el.value }));
  if (act === "weekly") guarded(async () => { S.me = await store.saveMyProfile({ weeklyCheckin: el.checked }); await reload(); say(el.checked ? "We'll check in with you each week." : "Weekly check-in turned off."); });
});
root.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  guarded(() => onSubmit(form)).then(flushSoon);
});

// ---------------------------------------------------------------- start

// ---------------------------------------------------------------- staying up to date
// While the app is open it checks for changes every 30 seconds, and straight away when the person
// comes back to it. It never redraws while they're typing or have changed a form, and it says
// what changed ("Jo cancelled their ride…").

const REFRESH_MS = 30000;
let refreshing = false;

function formInUse() {
  if (root.querySelector(".pinbox:not([hidden])")) return true; // placing a pin
  const a = document.activeElement;
  if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  for (const el of root.querySelectorAll("input, textarea, select")) {
    if (el.type === "hidden" || el.closest(".move")) continue;
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked !== el.defaultChecked) return true; }
    else if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true; }
    else if (el.value !== el.defaultValue) return true;
  }
  return false;
}

function snapshot() {
  const d = S.data;
  return {
    alerts: new Map((d?.alerts || []).filter((a) => !a.resolved).map((a) => [a.id, a])),
    requests: new Map((d?.requests || []).map((r) => [`${r.riderId}|${r.sunday}`, r.status])),
    help: JSON.stringify((d?.helpRequests || []).map((h) => [h.id, h.status, h.asks.map((a) => a.answer)])),
    asks: JSON.stringify((S.helpAsks || []).map((h) => [h.id, h.status, h.mine])),
    routes: JSON.stringify(S.routes || {}),
    rides: JSON.stringify(S.rides || []),
  };
}

function whatChanged(a, b) {
  const name = (id) => S.data?.profiles.find((p) => p.id === id)?.name || "Someone";
  const out = [];
  for (const [id, al] of b.alerts) if (!a.alerts.has(id)) out.push(al.message.replace(/\s*\(pickup[^)]*\)/, "").replace(/ They were in .*$/, ""));
  for (const [k, st] of b.requests) {
    const old = a.requests.get(k);
    const [rid] = k.split("|");
    if (!old && st !== "cancelled") out.push(`${name(rid)} asked for a ride.`);
    else if (old && old !== st && st === "requested") out.push(`${name(rid)} asked for a ride again.`);
    else if (old && old !== st && st === "cancelled" && !out.some((m) => m.startsWith(name(rid)))) out.push(`${name(rid)} cancelled.`);
  }
  if (a.help !== b.help && !out.length && S.me?.role === "leader") out.push("A driver answered a last-minute request.");
  if (a.asks !== b.asks) out.push("You have a last-minute ride request (or an update to one).");
  if (a.routes !== b.routes && S.me?.role !== "leader") out.push("Your pickups were updated.");
  if (a.rides !== b.rides) out.push("Your ride details were updated.");
  return out.length ? `Updated: ${out.slice(0, 3).join(" ")}${out.length > 3 ? ` (+${out.length - 3} more)` : ""}` : "";
}

async function refreshNow({ manual = false } = {}) {
  if (!S.session || !S.me || refreshing || S.busy) return;
  if (!manual && (document.hidden || formInUse() || S.editing)) return;
  refreshing = true;
  const before = snapshot();
  try {
    await load();
    S.lastSync = new Date();
    const msg = whatChanged(before, snapshot());
    if (S.roleNote) { S.toast = S.roleNote; S.roleNote = null; } else if (msg) S.toast = msg; else if (manual) S.toast = "You're up to date.";
  } catch (err) {
    console.error(err);
    if (manual) S.error = "Couldn't check for updates. Check your internet connection and try again.";
  } finally {
    refreshing = false;
    render();
  }
}

setInterval(() => refreshNow(), REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshNow(); });
window.addEventListener("focus", () => refreshNow());

(async function boot() {
  render();
  try {
    if (S.mode === "demo") {
      store = createDemoStore();
      S.demoPeople = store.people();
    } else {
      const { createLiveStore } = await import("./store-live.js");
      store = await createLiveStore(CONFIG);
    }
    await store.init(() => guarded(async () => { S.session = store.session(); if (S.session) await reload(); }));
    S.session = store.session();
    if (S.session) { await reload(); S.lastSync = new Date(); }
  } catch (err) {
    console.error(err);
    S.error = `Couldn't start the app: ${err.message}`;
  }
  render();
  // The service worker only handles notifications (it caches nothing, so the app always loads fresh).
  if (S.mode !== "demo" && CONFIG.push?.publicKey && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker", err));
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "refresh") refreshNow(); });
  }
})();


// ---------------------------------------------------------------- placing a pin on the house
// For homes the map service doesn't list by house number: the person uses their phone's location
// (when at home) or drags a pin onto their house. Their typed address is kept; the pin is the spot.

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletReady) leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css"; document.head.appendChild(css);
    const js = document.createElement("script"); js.src = LEAFLET + "leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletReady = null; reject(new Error("The map couldn't load. Check your internet connection and try again.")); };
    document.head.appendChild(js);
  });
  return leafletReady;
}

function phoneLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This phone or browser can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }),
      (err) => reject(new Error(err.code === 1
        ? "Location was not allowed. You can allow it in your browser settings, or place the pin by hand instead."
        : "We couldn't get your location just now. Try again outside or near a window, or place the pin by hand.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

async function onPin(btn) {
  const form = btn.closest("form");
  const box = form.querySelector(".pinbox");
  const help = box.querySelector(".pin-help");
  const status = form.querySelector(".addr-status");
  const mode = btn.dataset.pin;
  if (mode === "cancel") { box.hidden = true; return; }
  if (mode === "done") {
    const m = box._marker;
    if (!m) return;
    const { lat, lng } = m.getLatLng();
    if (!inSaskatoon(lat, lng)) { help.innerHTML = `<span class="warn-text">That spot is outside Saskatoon. Drag the pin onto the house.</span>`; return; }
    field(form, "pinLat").value = lat.toFixed(6);
    field(form, "pinLng").value = lng.toFixed(6);
    // "gps" only if the pin is still where the phone was (they were at home); moved further = by hand.
    const g = box._gps;
    field(form, "pinHow").value = g && inSaskatoon(g.lat, g.lng) && haversineKm(g, { lat, lng }) <= 0.06 ? "gps" : "pin";
    setPicked(form, null);
    box.hidden = true;
    const typed = field(form, "address").value.trim();
    status.innerHTML = `<span class="ok-text">📍 Pin placed on the house.</span>${houseNumberOf(typed) ? " Save to finish." : ` <span class="warn-text">Now type the house number and street above, so the driver knows which door.</span>`}`;
    // Fill the postal code and neighbourhood if they're empty (best effort).
    const r = await reverseLookup(lat, lng, { nominatimUrl: CONFIG.geocoding.nominatimUrl });
    const pc = field(form, "postalCode");
    if (pc && !pc.value.trim() && r.postcode) pc.value = r.postcode;
    const hood = r.neighbourhood || nearestNeighbourhood(lat, lng);
    if (hood && field(form, "neighbourhood")) { field(form, "neighbourhood").value = hood; const h = form.querySelector(".hood-name"); if (h) h.textContent = hood; }
    if (!typed && r.address && houseNumberOf(r.address)) { field(form, "address").value = r.address; status.innerHTML = `<span class="ok-text">📍 Pin placed on the house.</span> Check the address above is right, then save.`; }
    return;
  }

  // Open the map ("gps" = start at the phone's location, "map" = start near the typed street).
  box.hidden = false;
  help.textContent = mode === "gps" ? "Finding where you are…" : "Loading the map…";
  let start = null, zoom = 18, note = "";
  try {
    const [L] = await Promise.all([loadLeaflet(), mode === "gps" ? phoneLocation().then((p) => { start = p; }) : Promise.resolve()]);
    if (mode === "gps") {
      if (!inSaskatoon(start.lat, start.lng)) note = "Your phone seems to be outside Saskatoon right now. If you're not at home, drag the pin onto your house instead. ";
      else note = `We put the pin where your phone is${start.accuracy ? ` (accurate to about ${start.accuracy} m)` : ""}. `;
    } else {
      const typed = field(form, "address").value.trim();
      const near = lastList[0] || (typed ? await locateStreet(typed.replace(/^\s*\d+[A-Za-z]?\s*/, ""), { photonUrl: CONFIG.geocoding.photonUrl }) : null);
      start = near ? { lat: near.lat, lng: near.lng } : (S.church || { lat: 52.1332, lng: -106.67 });
      if (!near) zoom = 13;
    }
    if (box._map) { box._map.remove(); box._map = null; }
    box._gps = mode === "gps" ? { lat: start.lat, lng: start.lng } : null;
    const map = L.map(box.querySelector(".pinmap"), { zoomControl: true, attributionControl: true }).setView([start.lat, start.lng], zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
    const marker = L.marker([start.lat, start.lng], { draggable: true, autoPan: true }).addTo(map);
    map.on("click", (ev) => marker.setLatLng(ev.latlng));
    box._map = map; box._marker = marker;
    setTimeout(() => map.invalidateSize(), 50);
    help.innerHTML = `${note}${zoom < 18 ? "Zoom in to your street, then " : ""}Drag the pin (or tap the map) onto the house, then tap <strong>This is ${S.me?.role === "leader" && S.editing ? "the" : "my"} house</strong>.`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    help.innerHTML = `<span class="warn-text">${esc(err.message)}</span>${mode === "gps" ? ` <button type="button" class="btn link" data-pin="map">Place the pin by hand</button>` : ""}`;
  }
}
