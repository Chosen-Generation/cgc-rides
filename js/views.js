// Screens. Every function here takes the app state and returns an HTML string, nothing else:
// no network, no clicking. That keeps them testable in Node. Buttons carry data-act="..."
// and app.js listens for them. EVERY piece of user-supplied text goes through esc().

import { isConfirmed } from "./geo.js";
import { fmtDate, fmtMin, toMin } from "./dates.js";
import { serviceFor, isClosedFor, cutoffLabel, timeLabel, dayLabel, changedServices, isSunday, upcomingDays } from "./services.js";
const isClosed = (day, now) => isClosedFor(day, now);
import { driverAvailable, DRIVER_STATUS_TEXT, CONSENT_WORDING, daysLeft, isDriver } from "./models.js";
import { driverIssue } from "./matching.js";
import { groupCars } from "./planner.js";
import * as T from "./texts.js";

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const badge = (text, kind = "muted") => `<span class="badge ${kind}">${esc(text)}</span>`;
const banner = (kind, html) => `<div class="banner ${kind}">${html}</div>`;
const attr = (obj) => Object.entries(obj).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
const btn = (label, act, data = {}, kind = "ghost") => `<button class="btn ${kind}" type="button" data-act="${act}" ${attr(data)}>${esc(label)}</button>`;
const telLink = (p) => (p ? `<a href="tel:${esc(String(p).replace(/[^+\d]/g, ""))}">${esc(p)}</a>` : "");
const firstName = (n) => String(n || "").trim().split(/\s+/)[0];

function riderBadges(r) {
  return [
    r.priority && badge("Priority", "gold"),
    r.minor && badge("Under 18", "red"),
    r.rideHome && badge("Ride home too", "muted"),
    r.extraPeople > 0 && badge(`+${r.extraPeople} with them`, "clay"),
    r.extraPeople > 0 && r.canSplit && badge("OK to split", "muted"),
    ("geoSource" in r && !isConfirmed(r)) && badge("Address not confirmed", "red"),
  ].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- phone notifications

const PUSH_WHAT = {
  rider: "when your ride is confirmed or changes",
  driver: "when your route is ready, and when someone needs a last-minute ride",
  leader: "for new alerts, new drivers to approve, and your own driving",
};

/** The notifications card: an invitation when off, a short line (on the details tab) when on. */
export function pushCard(S) {
  const st = S.push;
  const role = S.me?.role;
  const detailsTab = S.tab === "details" || S.tab === "driving";
  if (!st || st === "unsupported" || st === "not-set-up") return "";
  const n = S.pushNote;
  const note = n ? `<p class="pushnote ${esc(n.kind)}" role="status">${esc(n.text)}</p>` : "";
  if (st === "on" && n) return `<article class="card pushcard">${note}</article>`;
  if (st === "on") return detailsTab ? `<p class="small muted pushline">🔔 Notifications are on for this device. ${btn("Turn off", "push-off", {}, "link")}</p>` : "";
  if (S.pushLater && !detailsTab) return "";
  const later = detailsTab ? "" : btn("Not now", "push-later", {}, "link");
  if (st === "ios-install") return `<article class="card pushcard"><h3>🔔 Get notified on your iPhone</h3>
    <p class="small">iPhones only send notifications from the app on your home screen. It takes a moment:</p>
    <ol class="small"><li>In Safari, tap the <strong>Share</strong> button (the square with an arrow).</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li><li>Open <strong>CGC Rides</strong> from your home screen, sign in, and tap <strong>Allow notifications</strong>.</li></ol>
    ${later}</article>`;
  if (st === "blocked" && n) return `<article class="card pushcard">${note}</article>`;
  if (st === "blocked") return detailsTab ? `<article class="card pushcard"><h3>🔔 Notifications are blocked</h3>
    <p class="small">You said no earlier, so your browser won't ask again. To allow them: on Android (Chrome), tap the icon left of the web address → <strong>Permissions</strong> (or Site settings) → <strong>Notifications</strong> → <strong>Allow</strong>. On iPhone: <strong>Settings → Notifications → CGC Rides</strong> → Allow. Then come back here.</p></article>` : "";
  return `<article class="card pushcard"><h3>🔔 Get a notification ${esc(PUSH_WHAT[role] || PUSH_WHAT.rider)}</h3>
    <p class="small muted">Works even when the app is closed. You can turn it off any time.</p>${note}
    <div class="row wrap">${btn(n && n.kind !== "wait" ? "Try again" : "Allow notifications", "push-on", {}, "primary")}${later}</div></article>`;
}

// ---------------------------------------------------------------- shell + entry screens

export function shell(S, inner) {
  const role = S.me?.role === "leader" ? (S.me.isSupervisor ? "supervisor" : (S.me.leaderTitle || "leader").toLowerCase()) : S.me?.role;
  const who = S.me ? `<span class="who">${esc(firstName(S.me.name))} · ${esc(role)}</span>` : "";
  const demo = S.mode === "demo"
    ? `<div class="demobar"><strong>DEMO</strong> · fictional people, nothing is saved. ${
        S.demoPeople ? `<label>View as <select data-act-change="viewas">${S.demoPeople.map((p) =>
          `<option value="${esc(p.id)}" ${S.session?.userId === p.id ? "selected" : ""}>${esc(p.name)} (${esc(p.role)})</option>`).join("")}</select></label>` : ""}</div>`
    : "";
  return `${demo}
  <header class="top">
    <a class="brand" href="#" data-act="home"><img src="assets/logo.png" alt="" width="36" height="36"><span>${esc(S.config.appName)}</span></a>
    <div class="topright">${who}${S.session ? btn("Sign out", "signout", {}, "link") : ""}</div>
  </header>
  <main>${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ""}${S.error ? banner("err", esc(S.error)) : ""}${inner}</main>
  <footer>${esc(S.config.churchName)} · Sunday service ${esc(fmtMin(toMin(S.config.service.time)))}</footer>`;
}

export function landingView(S) {
  return `<section class="hero">
    <img src="assets/logo.png" alt="Chosen Generation Church crown" width="96" height="96">
    <h1>Nobody in this church walks alone — including to the front door.</h1>
    <p class="lede">A ride to church shouldn't be the reason someone misses it. We match riders with drivers who are already headed their way.</p>
    <div class="stack">
      ${S.mode === "demo" ? btn("Try the demo", "demo-start", {}, "primary") : btn("Sign in or sign up", "goto-signin", {}, "primary")}
    </div>
    <ul class="points">
      <li><strong>Need a ride?</strong> Ask once, or every week with a quick check-in.</li>
      <li><strong>Can drive?</strong> Tell us your seats and which Sundays. We only plan around you when you're free.</li>
      <li><strong>Safe by design.</strong> Drivers are checked first, and your address is shared only with your driver.</li>
    </ul>
  </section>`;
}

export function signInView(S) {
  if (S.signInSent) return `<section class="card"><h2>Check your email</h2>
    <p>We sent a message to <strong>${esc(S.signInSent)}</strong>. Either tap the link in it, or type the code from it here (the number in large print). No password needed.</p>
    <form data-form="code" class="stack">
      <label class="field">Code from the email<input name="code" type="text" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,10}" maxlength="11" placeholder="12345678"></label>
      <button class="btn primary" type="submit">Sign in with code</button>
    </form>
    <div class="banner warn small"><strong>Don't see it within a minute? Check your spam or junk folder.</strong> The email is safe: it comes from our ride app's sign-in service. Mark it "Not spam" (or move it to your inbox), then tap the link or type the code. Codes and links last about an hour.</div>
    ${btn("Use a different email", "signin-reset")}</section>`;
  return `<section class="card"><h2>Sign in or sign up</h2>
    <p class="muted">Enter your email and we'll send you a one-time link. New here? The same link creates your account.</p>
    <form data-form="signin" class="stack">
      <label class="field">Email<input name="email" type="email" required autocomplete="email" inputmode="email"></label>
      <button class="btn primary" type="submit">Email me a link</button>
    </form></section>`;
}

export function demoPickerView(S) {
  const group = (role, title) => `<h3>${title}</h3><div class="grid">${S.demoPeople.filter((p) => p.role === role).map((p) =>
    `<button class="card pick" type="button" data-act="viewas" data-id="${esc(p.id)}"><strong>${esc(p.name)}</strong>${p.status && p.status !== "none" ? `<br>${badge(p.status, p.status === "cleared" ? "ok" : "clay")}` : ""}</button>`).join("")}</div>`;
  return `<section><h2>Pick who to view the app as</h2>
    <p class="muted">Every person below is made up. You can switch at any time using the bar at the top.</p>
    ${group("leader", "Transport leader")}${group("driver", "Drivers")}${group("rider", "Riders")}</section>`;
}

// ---------------------------------------------------------------- profile form (all roles)

export function profileForm(S, p0 = {}, { leaderEditing = false, registering = false, addingForSunday = null, leaderSelf = false } = {}) {
  // If saving failed, show what the person typed rather than the old values.
  const draft = S.formDraft ? Object.fromEntries(Object.entries(S.formDraft).filter(([k, v]) => v != null && k !== "picked")) : {};
  const p = { ...p0, ...draft };
  const isDrv = p.role === "driver";
  const req = `<span class="req" aria-hidden="true">*</span>`;
  const confirmed = isConfirmed(p0) && p.address === p0.address;
  const addrStatus = confirmed
    ? `<span class="ok-text">✓ ${p0.geoSource === "pin" ? "Pin placed on the map" : p0.geoSource === "gps" ? "Located with your phone" : "Confirmed on the map"}${p0.neighbourhood ? ` · ${esc(p0.neighbourhood)}` : ""}</span>`
    : p.address
      ? `<span class="warn-text">Not confirmed yet.</span> Pick your address from the list. Not there? Use one of the options below.`
      : "Start typing your house number and street, then pick your address from the list.";
  const chk = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> <span>${label}</span></label>`;
  const roleChoice = `<input type="hidden" name="role" value="${esc(p.role || "rider")}">`;
  const driverBits = (isDrv || leaderSelf) ? `<fieldset class="field driverbits"><legend>${registering ? "Your car" : "If you drive"}</legend>
      ${leaderSelf ? chk("alsoDrives", p.status === "cleared" && p.seats > 0, "<strong>I also drive</strong> (I'm cleared to drive myself)") : ""}
      <label class="field">Seats free for passengers (not counting you)<input name="seats" type="number" min="0" max="14" value="${esc(p.seats ?? 3)}"></label>
      <label class="field">Vehicle (so riders can spot you)<input name="vehicle" value="${esc(p.vehicle || "")}" placeholder="e.g. Grey SUV"></label>
      ${chk("drivesEveryWeek", p.drivesEveryWeek, "I drive <strong>every</strong> Sunday unless I say otherwise")}
      ${chk("secondTrip", p.secondTrip, "I can do a <strong>second trip</strong> if there are more riders than seats")}
      ${registering ? "" : '<p class="small muted">The transport leader will vet you and approve you before you are given riders.</p>'}
    </fieldset>` : "";
  const leaderBits = leaderEditing ? `<fieldset class="field"><legend>Leader only</legend>
      ${chk("priority", p.priority, "Priority rider (seated first)")}
      ${isDrv ? `<label class="field">Driver status<select name="status">${["pending", "cleared", "suspended"].map((s) => `<option ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <p class="small muted">Set the status to <strong>cleared</strong> once you have vetted this driver. The records below are optional notes for you.</p>${chk("licenceOk", p.licenceOk, "Licence seen (optional note)")}${chk("insuranceOk", p.insuranceOk, "Insurance seen (optional note)")}
      <label class="field">Police check expiry (optional note)<input name="policeCheckExpiry" type="date" value="${esc(p.policeCheckExpiry || "")}"></label>` : ""}
      ${addingForSunday ? chk("needsRide", true, `Needs a ride on ${esc(fmtDate(addingForSunday))}`) + `<label class="field">People coming with them<input name="extraPeople" type="number" min="0" max="10" value="0"></label>` + chk("canSplit", false, "They said it's OK to split across cars") + chk("consentByPhone", false, "They agreed by phone to receive ride texts") : ""}
    </fieldset>` : "";
  return `<form data-form="profile" class="stack" ${p.id ? `data-id="${esc(p.id)}"` : ""}>
    ${roleChoice}
    <p class="small muted">${req} Required</p>
    <label class="field"><span>Full name ${req}</span><input name="name" required value="${esc(p.name || "")}" autocomplete="name"></label>
    <label class="field"><span>Mobile phone ${req}${registering ? ` <span class="small muted">(so ${isDrv ? "riders and the leader" : "your driver"} can reach you)</span>` : ""}</span><input name="phone" type="tel" required inputmode="tel" value="${esc(p.phone || "")}" autocomplete="tel" placeholder="306-555-0142"></label>
    <div class="field addr">
      <label for="addr-input">Home address ${req}</label>
      <input id="addr-input" name="address" required value="${esc(p.address || "")}" autocomplete="off" placeholder="e.g. 1666 Stonebridge Blvd" aria-describedby="addr-status" aria-autocomplete="list" aria-controls="addr-suggest">
      <div class="suggest" id="addr-suggest" role="listbox" hidden></div>
      <p class="small muted addr-status" id="addr-status" aria-live="polite">${addrStatus}</p>
      <input type="hidden" name="pickedAddress" value=""><input type="hidden" name="pickedLat" value=""><input type="hidden" name="pickedLng" value="">
      <input type="hidden" name="pinLat" value=""><input type="hidden" name="pinLng" value=""><input type="hidden" name="pinHow" value="">
      <p class="pinbar small">${leaderEditing ? "" : `<button type="button" class="btn link" data-pin="gps">📍 I'm at home: use my current location</button><br>`}
        <button type="button" class="btn link" data-pin="map">Can't find the address? Place a pin on the map</button></p>
      <div class="pinbox" hidden>
        <p class="small pin-help" aria-live="polite">Loading the map…</p>
        <div class="pinmap" role="application" aria-label="Map: drag the pin onto the house"></div>
        <div class="row wrap"><button type="button" class="btn primary" data-pin="done">This is ${leaderEditing ? "the" : "my"} house</button><button type="button" class="btn ghost" data-pin="cancel">Cancel</button></div>
      </div>
    </div>
    <label class="field"><span>Postal code ${req} <span class="small muted">(filled in when you pick your address)</span></span><input name="postalCode" required value="${esc(p.postalCode || "")}" autocomplete="postal-code" placeholder="S7N 0A1" maxlength="7" style="text-transform:uppercase"></label>
    <input type="hidden" name="neighbourhood" value="${esc(p.neighbourhood || "")}">
    <p class="small muted hood-line">Neighbourhood: <strong class="hood-name">${esc(p.neighbourhood || "filled in from your address")}</strong></p>
    ${registering && isDrv ? "" : chk("minor", p.minor, "This rider is under 18")}
    <label class="field">${isDrv ? "Anything else we should know (optional)" : "Anything the driver should know (optional)"}<input name="notes" value="${esc(p.notes || "")}" placeholder="e.g. uses a walker"></label>
    ${driverBits}${leaderBits}
    <div class="row"><button class="btn primary" type="submit">${registering ? "Finish" : "Save"}</button>${leaderEditing ? btn("Cancel", "edit-cancel") : ""}</div>
  </form>`;
}

export function registerView(S) {
  const email = esc(S.session?.email || "");
  if (!S.regRole) return `<section class="card"><p class="small muted">Step 1 of 2</p><h2>Welcome! What brings you here?</h2>
    <p class="muted">Signed in as ${email}. Pick one. You can ask the transport leader to change it later.</p>
    <div class="stack">
      <button class="card pick" type="button" data-act="reg-role" data-role="rider"><strong>I need a ride to church</strong><br><span class="muted small">We'll match you with a driver each Sunday.</span></button>
      <button class="card pick" type="button" data-act="reg-role" data-role="driver"><strong>I can give rides</strong><br><span class="muted small">I have a car and some free seats.</span></button>
    </div></section>`;
  const driving = S.regRole === "driver";
  return `<section class="card"><p class="small muted">Step 2 of 2</p><h2>${driving ? "Tell us about you and your car" : "Tell us where to pick you up"}</h2>
    <p class="muted">Signed in as ${email}. ${driving ? "The transport leader will check your details and approve you before you are given riders. " : ""}Your address is only shown to the transport leader${driving ? " and to the riders you are given" : " and the driver assigned to you"}.</p>
    ${profileForm(S, { role: S.regRole }, { registering: true })}
    <p class="center">${btn("← Back", "reg-back")}</p></section>`;
}

// ---------------------------------------------------------------- rider

/** Card heading for a service day: "Sunday, October 25 · 11:45 AM", or "Christmas Eve service" with its date and time. */
function dayHeading(day) {
  const s = serviceFor(day);
  const date = fmtDate(day, { weekday: "long", month: "long", day: "numeric" });
  if (s.cancelled) return `<h3>${esc(date)} ${badge("No service", "muted")}</h3>`;
  const named = s.differs && s.title !== "Sunday service";
  return `<h3>${named ? `${esc(s.title)}<br><span class="small muted">${esc(date)}</span>` : esc(date)} <span class="badge ${s.differs ? "gold" : "muted"}">${esc(timeLabel(day))}</span></h3>${s.note ? `<p class="small">${esc(s.note)}</p>` : ""}`;
}

function consentBlock(S) {
  const me = S.me;
  if (me.textsConsentAt) {
    return `<div class="card soft"><strong>Ride texts: on</strong> <span class="small muted">(agreed ${esc(fmtDate(me.textsConsentAt.slice(0, 10), { month: "short", day: "numeric", year: "numeric" }))})</span> ${btn("Stop texts", "consent-off", {}, "link")}</div>`;
  }
  return `<div class="card soft"><strong>Get ride texts?</strong>
    <p class="small">${esc(CONSENT_WORDING)}</p>
    ${btn("Yes, text me about my rides", "consent-on", {}, "primary")}</div>`;
}

export function riderView(S) {
  const me = S.me;
  if (S.tab === "details") return `<section class="card"><h2>My details</h2>${profileForm(S, me)}</section>`;
  const requestForm = (sunday, again) => `<form data-form="request" data-sunday="${esc(sunday)}" class="stack">
            <label class="field">How many people are coming with you? <span class="small muted">(not counting you; each needs a seat)</span>
              <input name="extraPeople" type="number" inputmode="numeric" min="0" max="10" value="0"></label>
            <label class="check"><input type="checkbox" name="canSplit"> <span>It's OK to split us across different cars if no single car has room for everyone</span></label>
            <label class="check"><input type="checkbox" name="rideHome"> <span>I need a ride home too</span></label>
            <label class="field">Note for the leader (optional)<input name="note" placeholder="e.g. bringing a small child"></label>
            <button class="btn primary" type="submit">${again ? "Ask again" : "I need a ride"}</button></form>`;
  const cards = S.sundays.map((sunday) => {
    const rows = S.rides.filter((r) => r.sunday === sunday);
    const ride = rows[0];
    const closed = isClosed(sunday, S.now);
    const party = ride ? 1 + (ride.extraPeople || 0) : 1;
    let body;
    const svc = serviceFor(sunday);
    if (svc.cancelled) {
      body = `<p class="muted">There's no service this day, so no rides are arranged.</p>`;
    } else if (!ride || ride.status === "cancelled") {
      body = closed
        ? `<p class="muted">Requests for this service have closed. Please contact the transport leader.</p>`
        : `${requestForm(sunday, !!ride)}${ride ? `<p class="small muted">You cancelled this one.</p>` : ""}`;
    } else if (ride.status === "seated") {
      body = rows.map((r) => `<div class="driver">
          <p><strong>${esc(r.driverName)}</strong> will pick up ${party > 1 ? `${esc(r.seats)} of your group of ${esc(party)}` : "you"}${r.vehicle ? ` in a ${esc(r.vehicle)}` : ""}.</p>
          <p class="bigtime">Around ${esc(fmtMin(r.pickupMin))}</p>
          <p>Please be ready by <strong>${esc(fmtMin(r.readyByMin))}</strong> to avoid delays.</p>
          ${r.driverPhone ? `<p>Driver's number: ${telLink(r.driverPhone)}</p>` : ""}
        </div>`).join("") +
        (ride.waitlistedSeats ? banner("warn", `${esc(ride.waitlistedSeats)} more of your group still need a seat. The transport leader will contact you.`) : "") +
        (ride.rideHome ? `<p class="small muted">You asked for a ride home too. The leader will confirm that separately.</p>` : "") +
        btn("I can't make it", "cancel-ride", { sunday }, "danger");
    } else if (ride.status === "waitlisted") {
      body = `<p>We're still working on ${party > 1 ? "seats for your group" : "a seat for you"}. The transport leader will message you as soon as we have ${party > 1 ? "them" : "one"}.</p>${btn("I can't make it", "cancel-ride", { sunday }, "danger")}`;
    } else {
      body = `<p>${badge("Requested", "gold")} ${party > 1 ? `For ${esc(party)} people. ` : ""}The leader will confirm your driver after requests close (${esc(cutoffLabel(sunday))}).${party > 1 ? (ride.canSplit ? " You said it's OK to split across cars." : " You asked to stay together; if that isn't possible the leader will ask you.") : ""}</p>${btn("Cancel my request", "cancel-ride", { sunday }, "ghost")}`;
    }
    return `<article class="card">${dayHeading(sunday)}${body}</article>`;
  }).join("");
  return `<section><h2>Hi ${esc(firstName(me.name))}</h2>
    ${!isConfirmed(me) ? banner("warn", `<strong>Please confirm your home address.</strong> We can only arrange a ride once your address is confirmed on the map. ${btn("Confirm my address", "tab", { tab: "details" }, "primary")}`) : ""}
    <label class="check card soft"><input type="checkbox" data-act-change="weekly" ${me.weeklyCheckin ? "checked" : ""}> <span><strong>Check in with me every week.</strong><br><span class="small muted">We'll ask “Do you need a ride this Sunday?” If you don't answer, we won't assume you do.</span></span></label>
    ${cards}${consentBlock(S)}</section>`;
}

// ---------------------------------------------------------------- driver

function mapsLink(S, stops) {
  const c = S.church;
  if (!c || c.lat == null) return "";
  const pts = stops.filter((s) => s.lat != null).map((s) => `${s.lat},${s.lng}`);
  if (!pts.length) return "";
  const q = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${c.lat},${c.lng}&waypoints=${pts.join("%7C")}`;
  return `<a class="btn primary" href="${esc(q)}" target="_blank" rel="noopener">Open route in Google Maps</a>`;
}

export function driverView(S) {
  const me = S.me;
  if (S.tab === "details") return `<section class="card"><h2>My details</h2>${profileForm(S, me)}</section>`;
  const status = me.status === "cleared"
    ? banner("ok", "Cleared to drive.")
    : banner(me.status === "suspended" ? "err" : "warn", esc(DRIVER_STATUS_TEXT[me.status] || DRIVER_STATUS_TEXT.pending) + ".");
  const cards = S.sundays.map((sunday) => {
    const avail = driverAvailable(me, S.weeks, sunday);
    const route = S.routes[sunday] || [];
    const trips = [...new Set(route.map((r) => r.trip))];
    const svc = serviceFor(sunday);
    const what = svc.sunday && !svc.differs ? "this Sunday" : "for this service";
    let body = svc.cancelled ? `<p class="muted">There's no service this day.</p>` : `<p>${avail ? badge("You're driving", "ok") : badge(svc.special ? "Can you drive?" : "Not driving", svc.special ? "gold" : "muted")}
      ${btn(avail ? `I can't drive ${what}` : `I can drive ${what}`, "toggle-avail", { sunday, to: avail ? "no" : "yes" }, avail ? "ghost" : (svc.special ? "primary" : "ghost"))}</p>
      ${svc.special && !avail ? `<p class="small muted">This is a special service. Tap the button if you can give rides for it.</p>` : ""}`;
    if (route.length) {
      body += trips.map((t) => {
        const stops = route.filter((r) => r.trip === t);
        const leave = stops[0].departMin;
        return `<div class="route"><h4>${trips.length > 1 ? `Trip ${t}` : "Your pickups"}</h4>
          ${leave != null ? `<p class="leave">Leave ${t > 1 ? "church" : "home"} by <strong>${esc(fmtMin(leave))}</strong></p>` : ""}
          <ol class="stops">${stops.map((s) => `<li>
            <div class="stoptime">${esc(fmtMin(s.pickupMin))}<span class="small muted">ready ${esc(fmtMin(s.readyByMin))}</span></div>
            <div><strong>${esc(s.riderName)}</strong> ${riderBadges({ minor: s.minor, rideHome: s.rideHome })}${s.seats > 1 ? ` ${badge(`${s.seats} people`, "clay")}` : ""}${s.partyTotal > s.seats ? `<br><span class="small">Part of a group of ${esc(s.partyTotal)}; the rest ride with another driver.</span>` : ""}<br>
            ${esc(s.address || "")}${s.neighbourhood ? ` <span class="muted">· ${esc(s.neighbourhood)}</span>` : ""}<br>
            ${telLink(s.riderPhone)}
            ${s.riderNotes ? `<br><em>${esc(s.riderNotes)}</em>` : ""}${s.requestNote ? `<br><em>${esc(s.requestNote)}</em>` : ""}</div></li>`).join("")}</ol>
          <p class="small muted">Aim to arrive at church by ${esc(fmtMin(stops[0].arriveMin))}.</p>${mapsLink(S, stops)}</div>`;
      }).join("") + `<p>${btn("I can't make it", "cant-make-it", { sunday }, "danger")}</p>`;
    } else if (avail && !svc.cancelled) {
      body += `<p class="muted">No riders confirmed yet. You'll see your pickups here once the leader approves the plan.</p>`;
    }
    return `<article class="card">${dayHeading(sunday)}${body}</article>`;
  }).join("");
  // Last-minute requests from the leader: answer Yes or No. Address only once the ride is yours.
  const helpCards = (S.helpAsks || []).map((h) => {
    const when = esc(fmtDate(h.sunday, { weekday: "long", month: "long", day: "numeric" }));
    if (h.mine) return `<article class="card ok-card"><h3>Last-minute pickup: ${esc(h.riderName)}</h3>
      <p>${when}, around <strong>${esc(fmtMin(h.pickupMin))}</strong>${h.seats > 1 ? ` · ${esc(h.seats)} people` : ""}</p>
      <p><strong>${esc(h.address || "")}</strong>${h.neighbourhood ? ` <span class="muted">· ${esc(h.neighbourhood)}</span>` : ""}${h.riderPhone ? `<br>${telLink(h.riderPhone)}` : ""}</p>
      <p class="small muted">Thank you for helping! Fit this in on your way to church.</p></article>`;
    if (h.status === "covered") return `<article class="card soft"><p><strong>${esc(h.riderName)}'s ride on ${when} has been covered.</strong> Thank you for being ready to help.</p></article>`;
    if (h.myAnswer === "no") return `<article class="card soft"><p>You said you can't pick up ${esc(h.riderName)} on ${when}. Thanks for letting us know. ${btn("Actually, I can", "help-answer", { id: h.id, answer: "yes" }, "link")}</p></article>`;
    return `<article class="card warn"><h3>Can you help? Last-minute ride request</h3>
      <p><strong>${esc(h.riderName)}</strong>${h.neighbourhood ? ` in ${esc(h.neighbourhood)}` : ""} needs a ride to church on ${when}${h.seats > 1 ? ` (${esc(h.seats)} people)` : ""}.
      You're about <strong>${esc(h.awayMin)} minutes</strong> from them. Pickup around <strong>${esc(fmtMin(h.pickupMin))}</strong>.</p>
      <div class="row wrap">${btn("Yes, I can", "help-answer", { id: h.id, answer: "yes" }, "primary")}${btn("No, sorry", "help-answer", { id: h.id, answer: "no" })}</div>
      <p class="small muted">If you're the first to say yes, you'll see the address here.</p></article>`;
  }).join("");
  return `<section><h2>Hi ${esc(firstName(me.name))}</h2>${status}${helpCards}
    ${!isConfirmed(me) ? banner("warn", `<strong>Please confirm your home address.</strong> You won't be given riders until it's confirmed on the map, because pickup times are worked out from it. ${btn("Confirm my address", "tab", { tab: "details" }, "primary")}`) : ""}
    <p class="small muted">${esc(me.seats)} seat(s)${me.secondTrip ? " · second trip OK" : ""}${me.vehicle ? ` · ${esc(me.vehicle)}` : ""}. Change in My details.</p>${cards}${consentBlock(S)}</section>`;
}

// ---------------------------------------------------------------- leader

function ridersMap(S) { return new Map(S.data.profiles.map((p) => [p.id, p])); }

function carOptions(S, sunday) {
  const weeks = S.data.weeks;
  const out = [];
  for (const d of S.data.profiles.filter(isDriver)) {
    if (driverIssue({ ...d, available: driverAvailable(d, weeks, sunday) }, sunday)) continue;
    out.push({ value: `${d.id}|1`, label: `${d.name} · trip 1`, d, trip: 1 });
    if (d.secondTrip) out.push({ value: `${d.id}|2`, label: `${d.name} · trip 2`, d, trip: 2 });
  }
  return out;
}

function moveSelect(S, riderId, current) {
  const opts = carOptions(S, S.sunday);
  return `<select class="move" data-act-change="move" data-rider="${esc(riderId)}" data-from="${esc(current)}" aria-label="Move rider">
    <option value="">Move to…</option>
    ${opts.filter((o) => o.value !== current).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}
    ${current !== "wait" ? `<option value="wait">Waitlist</option>` : ""}</select>`;
}

function planTab(S) {
  const sunday = S.sunday;
  const people = ridersMap(S);
  const asking = S.data.requests.filter((r) => r.sunday === sunday && r.status !== "cancelled");
  const cars = carOptions(S, sunday);
  const seats = cars.reduce((n, c) => n + c.d.seats, 0);
  const askingPeople = asking.reduce((n, r) => n + 1 + (r.extraPeople || 0), 0);
  const pv = S.planView;
  const chips = S.sundays.map((s) => {
    const n = S.data.requests.filter((r) => r.sunday === s && r.status !== "cancelled").length;
    const st = S.data.plans[s]?.status;
    const sv = serviceFor(s);
    const label = sv.cancelled ? "No service" : sv.differs && sv.title !== "Sunday service" ? `${sv.title} · ${timeLabel(s)}` : `${n} asking${st ? ` · ${st}` : ""}`;
    return `<button type="button" class="chip ${s === sunday ? "on" : ""} ${sv.differs ? "special" : ""}" data-act="pick-sunday" data-sunday="${esc(s)}">${esc(fmtDate(s))}<small>${esc(label)}</small></button>`;
  }).join("");

  let html = `<div class="chips">${chips}</div>`;
  const svcDay = serviceFor(sunday);
  if (svcDay.cancelled) {
    return html + banner("info", `<strong>No service on ${esc(fmtDate(sunday, { weekday: "long", month: "long", day: "numeric" }))}.</strong> Nobody can ask for a ride and no plan is made. Change this in the Services tab.`);
  }
  if (svcDay.differs) html += `<p class="svcline"><strong>${esc(svcDay.title)}</strong> · ${esc(fmtDate(sunday, { weekday: "long", month: "long", day: "numeric" }))} · starts ${esc(timeLabel(sunday))}</p>`;
  if (S.churchWarning) html += banner("warn", `<strong>Church location not set.</strong> ${esc(S.churchWarning)}`);
  else if (S.churchFound && S.mode !== "demo") {
    const f = S.churchFound;
    const map = `<a href="https://www.openstreetmap.org/?mlat=${esc(f.lat)}&mlon=${esc(f.lng)}#map=18/${esc(f.lat)}/${esc(f.lng)}" target="_blank" rel="noopener">check on the map</a>`;
    html += f.pinned
      ? `<p class="small muted">Times are worked out to the church's pinned location (${map}).</p>`
      : banner("info", `<strong>Church location:</strong> ${esc(f.address)}${f.postcode ? `, ${esc(f.postcode)}` : ""} (${map}). Pickup times are worked back from this point. If the pin isn't at the church, put the exact latitude and longitude in js/config.js.`);
  }
  html += `<p class="small muted">Times use real road times plus a ${esc(S.config.matching.trafficPct ?? 20)}% safety margin and ${esc(S.config.matching.legBufferMin ?? 1)} min per drive, ${esc(S.config.matching.stopMin)} min at each house, arriving ${esc(serviceFor(sunday).arriveBeforeMin)} min before the service at ${esc(timeLabel(sunday))}.</p>`;
  if (S.mode === "demo") html += banner("info", `Demo plans use a placeholder church location (${esc(S.demoChurchLabel)}).`);
  html += `<div class="tiles"><div class="tile"><b>${askingPeople}</b>people asking</div><div class="tile"><b>${seats}</b>seats offered</div>
    <div class="tile"><b>${pv?.assignments.reduce((n, a) => n + (a.seats ?? 1), 0) ?? 0}</b>${pv && pv.status === "approved" && !pv.dirty ? "seated and shared" : "in a car (not shared yet)"}</div><div class="tile"><b>${pv?.waitlist.reduce((n, w) => n + (w.seats ?? 1), 0) ?? 0}</b>waiting</div></div>`;
  if (askingPeople > seats) html += banner("warn", `${askingPeople} people are asking (counting those coming with riders) but only ${seats} seats are offered. Ask drivers about a second trip, or recruit another driver.`);

  const status = !pv ? badge("No plan yet", "muted") : pv.status === "approved" ? badge(pv.dirty ? "Approved · changes not saved" : "Approved and shared", "ok") : badge(pv.dirty ? "Draft · not saved" : "Draft saved", "gold");
  const placed = new Set(pv ? [...pv.assignments.map((a) => a.riderId), ...pv.waitlist.map((w) => w.riderId)] : []);
  const newcomers = pv ? asking.filter((r) => !placed.has(r.riderId)) : [];
  const open = !!(S.planOpen && pv);
  const seatedN = pv ? pv.assignments.reduce((n, a) => n + (a.seats ?? 1), 0) : 0;
  const waitingN = pv ? pv.waitlist.reduce((n, w) => n + (w.seats ?? 1), 0) : 0;
  const carsN = pv ? new Set(pv.assignments.map((a) => `${a.driverId}|${a.trip}`)).size : 0;
  // The plan follows the requests automatically (see autoUpdatePlan in app.js); this says what changed.
  const newcomerBanner = pv?.autoNote
    ? banner("info", `<strong>Updated automatically.</strong> ${esc(pv.autoNote)} Not saved or shared yet: view it, then save a draft or approve.`)
    : newcomers.length
      ? banner("info", `${newcomers.length} new request${newcomers.length > 1 ? "s" : ""} (${newcomers.map((r) => esc(people.get(r.riderId)?.name || "Rider")).join(", ")}) will be added to the plan automatically.`)
      : "";

  html += `<div class="row wrap">${status}${S.busy ? `<span class="small muted">Working…</span>` : ""}</div>
    <div class="row wrap">${open ? btn("Hide the plan", "hide-plan") : btn(pv ? "View the plan" : "Make and view the plan", "view-plan", {}, "primary")}</div>
    <p class="small muted">Requests close ${esc(cutoffLabel(sunday))}${isClosed(sunday, S.now) ? " (closed)" : ""}. Nothing reaches drivers and riders until you approve.</p>`;

  if (!open) {
    if (!pv) {
      html += `<h3>Asking for a ride (${asking.length})</h3><ul class="plain">${asking.map((r) => { const p = people.get(r.riderId); return p ? `<li><strong>${esc(p.name)}</strong> ${esc(p.neighbourhood || "")} ${riderBadges({ ...p, rideHome: r.rideHome, extraPeople: r.extraPeople, canSplit: r.canSplit })}${r.note ? `<br><span class="small muted">${esc(r.note)}</span>` : ""}</li>` : ""; }).join("") || "<li class='muted'>Nobody yet.</li>"}</ul>`;
    } else {
      html += `<p>${seatedN} seated in ${carsN} car${carsN === 1 ? "" : "s"}${waitingN ? `, ${waitingN} on the waiting list` : ""}. Tap <strong>View the plan</strong> to see the cars, make changes and approve.</p>${newcomerBanner}`;
    }
    return html;
  }

  html += `<section class="planbox" aria-label="The plan for ${esc(fmtDate(sunday))}">${newcomerBanner}`;
  if (pv.travelNote) html += banner("warn", esc(pv.travelNote));
  else if (pv.travelSource === "estimate" && !S.config.routing.enabled) html += banner("info", "Using straight-line estimates (road routing is switched off in settings).");
  if (pv.warnings?.length) html += banner("warn", `<strong>Check these:</strong><ul>${pv.warnings.map((w) => `<li>${esc(w.text)}</li>`).join("")}</ul>`);
  html += `<p class="small muted">Leave it as it is, or use <strong>Move to…</strong> under anyone to put them in another car or on the waiting list. Times update as you go.</p>`;

  const cardsData = groupCars(pv.assignments, S.data.profiles);
  const tripMeta = new Map((pv.trips || []).map((t) => [`${t.driverId}|${t.trip}`, t]));
  html += cardsData.map((car) => {
    const d = people.get(car.driverId);
    const meta = tripMeta.get(`${car.driverId}|${car.trip}`);
    return `<article class="card car"><header><h3>${esc(d?.name || "Driver")}${car.trip > 1 ? " · trip 2" : ""}</h3>
      <span class="small muted">${car.stops.length}/${esc(d?.seats ?? "?")} seats${d?.vehicle ? ` · ${esc(d.vehicle)}` : ""}${meta ? ` · leaves ${esc(fmtMin(meta.departMin))} · arrives ${esc(fmtMin(meta.arriveMin))}` : car.stops[0]?.departMin != null ? ` · leaves ${esc(fmtMin(car.stops[0].departMin))} · arrives ${esc(fmtMin(car.stops[0].arriveMin))}` : ""}</span></header>
      <ol class="stops">${car.stops.map((s) => { const r = people.get(s.riderId); return `<li><div class="stoptime">${esc(fmtMin(s.pickupMin))}<span class="small muted">ready ${esc(fmtMin(s.readyByMin))}</span></div>
        <div><strong>${esc(r?.name || "Rider")}</strong> ${riderBadges({ ...(r || {}), rideHome: asking.find((q) => q.riderId === s.riderId)?.rideHome, extraPeople: asking.find((q) => q.riderId === s.riderId)?.extraPeople, canSplit: asking.find((q) => q.riderId === s.riderId)?.canSplit })}${s.seats > 1 ? ` ${badge(`${s.seats} seats`, "gold")}` : ""}<br><span class="small">${esc(r?.address || "")}${r?.neighbourhood ? ` · ${esc(r.neighbourhood)}` : ""}</span>${asking.find((q) => q.riderId === s.riderId)?.note ? `<br><em class="small">${esc(asking.find((q) => q.riderId === s.riderId).note)}</em>` : ""}<br>${moveSelect(S, s.riderId, `${car.driverId}|${car.trip}`)}</div></li>`; }).join("")}</ol></article>`;
  }).join("") || `<p class="muted">Nobody is seated yet.</p>`;

  if (pv.waitlist.length) {
    html += `<h3>Waiting list (${pv.waitlist.length})</h3>` + pv.waitlist.map((w) => {
      const r = people.get(w.riderId);
      const q = asking.find((x) => x.riderId === w.riderId);
      return `<article class="card warn"><strong>${esc(r?.name || "Rider")}</strong> ${r ? riderBadges({ ...r, extraPeople: q?.extraPeople, canSplit: q?.canSplit }) : ""} ${w.seats > 1 ? badge(`needs ${w.seats} seats`, "gold") : ""}<p class="small">${esc(w.reason)}</p>${q?.note ? `<p class="small"><em>${esc(q.note)}</em></p>` : ""}
        ${w.seats > 1 && q && !q.canSplit ? `<p class="small">${btn("They agree to be split across cars", "split-ok", { rider: w.riderId }, "primary")}</p>` : ""}${moveSelect(S, w.riderId, "wait")}</article>`;
    }).join("");
  }
  if (pv.excluded?.length) {
    html += `<details class="card soft"><summary>${pv.excluded.length} driver(s) not driving this day</summary><ul class="plain">${pv.excluded.map((e) => `<li><strong>${esc(e.name)}</strong>: ${esc(e.reason)}</li>`).join("")}</ul></details>`;
  }

  // Save draft sits beside Approve & share, under the plan. Save draft is only active after a change.
  const approvedClean = pv.status === "approved" && !pv.dirty;
  const saveBtn = `<button class="btn ghost" type="button" data-act="save-draft" ${pv.dirty ? "" : "disabled"}>Save draft</button>`;
  const approveBtn = approvedClean
    ? `<button class="btn primary" type="button" disabled>Approved and shared ✓</button>`
    : btn(pv.status === "approved" ? "Approve & share changes" : "Approve & share", "approve", {}, "primary");
  const hint = approvedClean
    ? "Drivers and riders can see this plan. Change anything above and you can share the update."
    : pv.dirty
      ? "You have changes that aren't saved. Save them as a draft for later, or approve to share them now."
      : "No changes since it was saved. Approve to share it with drivers and riders, or change something above.";
  html += `<div class="planactions"><div class="row wrap">${saveBtn}${approveBtn}</div><p class="small muted">${hint}</p></div>
    <p class="small muted">Starting from scratch? ${btn("Start the plan over", "draft", {}, "link")}</p></section>`;
  return html;
}

// The team: the supervisor and up to two leaders. Only the supervisor can change it.
const TEAM_MAX = 2;
function teamSection(S) {
  const all = S.data.profiles;
  const sup = all.find((p) => p.role === "leader" && p.isSupervisor);
  const leaders = all.filter((p) => p.role === "leader" && !p.isSupervisor);
  const iAmSup = !!S.me.isSupervisor;
  const title = (p) => p.isSupervisor ? "Supervisor" : p.leaderTitle || "Leader";
  const taken = (t) => leaders.some((l) => (l.leaderTitle || "Leader") === t);
  // Switch Leader <-> Assistant leader, only when the other title is free.
  const swap = (p) => {
    const to = title(p) === "Assistant leader" ? "Leader" : "Assistant leader";
    return taken(to) ? "" : btn(`Make ${to === "Leader" ? "Leader" : "Assistant"}`, "team-role", { id: p.id, role: to === "Leader" ? "leader" : "assistant" });
  };
  const row = (p) => `<li class="personrow"><div><strong>${esc(p.name)}</strong>${p.id === S.me.id ? " (you)" : ""} ${badge(title(p), p.isSupervisor ? "ok" : "muted")}<br>
    <span class="small muted">${esc(p.email || p.phone || "")}</span></div>
    ${iAmSup && !p.isSupervisor ? `<div class="row wrap">${swap(p)}${btn("Move to driver", "team-role", { id: p.id, role: "driver" })}${btn("Move to rider", "team-role", { id: p.id, role: "rider" })}</div>` : ""}</li>`;
  let html = `<article class="card team"><h3>Team</h3>
    <ul class="plain">${[sup, ...leaders].filter(Boolean).map(row).join("")}</ul>`;
  if (!iAmSup) {
    html += `<p class="small muted">${sup ? `${esc(sup.name)} is the supervisor and decides who leads.` : "No supervisor is set yet."} Leaders can do everything else in the app.</p></article>`;
    return html;
  }
  // Signed-in people only: someone the leader added by phone has no login, so can't lead.
  const candidates = all.filter((p) => p.role !== "leader" && p.userId).sort((a, b) => a.name.localeCompare(b.name));
  html += `<p class="small muted">You're the supervisor: you choose up to two leaders (a Leader and an Assistant leader). Leaders can do everything in the app except change the team. Anyone moved back keeps their details; a driver keeps their checks.</p>`;
  html += leaders.length >= TEAM_MAX
    ? `<p class="small">You have two leaders. To add someone else, move one back to driver or rider first.</p>`
    : candidates.length
      ? `<form data-form="team-add" class="stack"><label class="field">Make a leader
          <select name="person" required><option value="">Choose someone who has signed in…</option>${candidates.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.role)})</option>`).join("")}</select></label>
          <fieldset class="field"><legend>As</legend>
          ${taken("Leader") ? "" : `<label class="check"><input type="radio" name="role" value="leader" checked> Leader</label>`}
          ${taken("Assistant leader") ? "" : `<label class="check"><input type="radio" name="role" value="assistant" ${taken("Leader") ? "checked" : ""}> Assistant leader</label>`}</fieldset>
          <button class="btn primary" type="submit">Make leader</button></form>`
      : `<p class="small muted">No one else has signed in yet. Once someone registers in the app, you can make them a leader here.</p>`;
  html += `</article>`;

  // Handing over
  html += `<article class="card team"><h3>Hand over the supervisor role</h3>`;
  if (!leaders.length) {
    html += `<p class="small muted">When you leave, make the next person a leader first (above), then hand over to them here.</p>`;
  } else {
    html += `<p class="small muted">For when you step down. The person you choose becomes supervisor and can then choose the other leaders. You can't undo this yourself: only the new supervisor can give it back.</p>
      <form data-form="handover" class="stack">
      <label class="field">Hand over to <select name="person" required><option value="">Choose a leader…</option>${leaders.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(title(p))})</option>`).join("")}</select></label>
      <label class="field">After that, I will be
        <select name="myRole"><option value="rider">a rider</option><option value="driver">a driver (keeps my car details)</option><option value="assistant">an assistant leader</option><option value="leader">a leader</option></select></label>
      <label class="field">Type their full name to confirm <input name="confirmName" autocomplete="off" required></label>
      <button class="btn danger" type="submit">Hand over</button></form>`;
  }
  html += `</article>`;

  const log = S.data.teamLog || [];
  if (log.length) html += `<details class="card"><summary>Team changes (${log.length})</summary><ul class="plain small">${log.map((t) =>
    `<li>${esc(fmtDate(String(t.at).slice(0, 10), { month: "short", day: "numeric", year: "numeric" }))}: ${esc(t.actorName || "Someone")} ${esc(t.change)}</li>`).join("")}</ul></details>`;
  return html;
}

// Leaders remind people about their home location: pins placed by hand (check it from home), and
// addresses not confirmed yet (place a pin). Sent as a notification; the rest get a text to copy.
export const REMIND = {
  pins: { title: "Check your pin", text: "When you're at home, open Chosen Generation Rides, go to My details and tap \"I'm at home: use my current location\", so your driver comes to the right door." },
  unconfirmed: { title: "Your address isn't on the map yet", text: "Open Chosen Generation Rides, go to My details and place a pin on your house (or pick your address from the list), so we can include you for rides." },
};
export function remindGroups(S) {
  // People who can sign in (riders, drivers, and leaders who drive).
  const people = (S.data.profiles || []).filter((p) => p.userId && (p.role !== "leader" || isDriver(p)));
  return {
    pins: people.filter((p) => p.geoSource === "pin"),
    unconfirmed: people.filter((p) => !isConfirmed(p)),
  };
}
function addressReminderBox(S) {
  const g = remindGroups(S);
  if (!g.pins.length && !g.unconfirmed.length && !S.remindResult) return "";
  const names = (list) => list.map((p) => esc(firstName(p.name))).join(", ");
  const part = (key, list, label, why) => list.length ? `<div class="remind"><p><strong>${label} (${list.length})</strong>: ${names(list)}</p>
      <p class="small muted">${why}</p>${btn("Send reminder", "remind", { group: key })}</div>` : "";
  let html = `<article class="card soft"><h3>Home locations</h3>
    ${part("pins", g.pins, "Pins placed by hand", "They placed the pin away from home. The reminder asks them to check it with their phone's location when they're home.")}
    ${part("unconfirmed", g.unconfirmed, "Not on the map yet", "They can't be matched until their home is confirmed. The reminder asks them to place a pin.")}`;
  const r = S.remindResult;
  if (r) {
    const msg = `Hi! ${REMIND[r.group].text} ${S.appUrl || ""}`.trim();
    html += `<div class="banner ok"><p>Reminder sent as a notification to ${r.sent} ${r.sent === 1 ? "person" : "people"}.</p>
      ${r.others.length ? `<p>These don't have notifications on, so text them:</p><ul class="plain small">${r.others.map((p) => `<li>${esc(p.name)} · ${esc(p.phone || "no phone")}</li>`).join("")}</ul><p>${btn("Copy the text message", "copy", { text: msg })}</p>` : ""}</div>`;
  }
  return html + `</article>`;
}

// People who signed in with their email but never filled in their details.
function unregisteredBox(S) {
  const list = S.data.unregistered || [];
  if (!list.length) return "";
  // Local date (not UTC), e.g. "Oct 25".
  const when = (iso) => (iso ? new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(new Date(iso)) : "");
  const url = S.appUrl || "the app";
  // Asked for the sign-in email but never opened it: usually it went to spam, or they gave up waiting.
  const neverOpened = list.filter((u) => !u.lastSignInAt);
  // Opened the email and got in, but never filled in their details.
  const stopped = list.filter((u) => u.lastSignInAt);
  const msgEmail = `Hi! You started signing up for ${S.config.appName} but didn't finish.

1. Open ${url}
2. Sign in with this email address.
3. We'll email you a sign-in link. If you don't see it within a minute, check your spam or junk folder. It's safe: it comes from our ride app's sign-in service. Mark it "Not spam", then tap the link.
4. Fill in your details and you're all set for rides.

Thank you!`;
  const msgDetails = `Hi! You signed in to ${S.config.appName} but didn't finish filling in your details, so we can't include you for rides yet.

1. Open ${url} (you may still be signed in).
2. Fill in your name, phone and home address.
3. If your address doesn't show up in the list, tap "Place a pin on the map" under the address and put the pin on your house.
4. Save, and you're all set.

Thank you!`;
  const issues = S.data.signupIssues || [];
  const lastIssue = (email) => issues.find((x) => (x.email || "").toLowerCase() === (email || "").toLowerCase());
  const rows = (arr, label) => `<ul class="plain">${arr.map((u) => { const li = lastIssue(u.email); return `<li class="personrow"><div><strong>${esc(u.email)}</strong><br><span class="small muted">${label} ${esc(when(label === "asked" ? u.signedUpAt : u.lastSignInAt))}</span>${li ? `<br><span class="small warn-text">Stopped at: ${esc(li.category)}: “${esc(li.message)}”</span>` : ""}</div>${btn("Copy email", "copy", { text: u.email })}</li>`; }).join("")}</ul>`;
  const emails = (arr) => arr.map((u) => u.email).join(", ");
  const group = (arr, title, why, label, msg) => arr.length ? `<h4>${title} (${arr.length})</h4><p class="small muted">${why}</p>${rows(arr, label)}
    <div class="row wrap">${btn("Copy reminder message", "copy", { text: msg })}${btn("Copy all their emails", "copy", { text: emails(arr) })}</div>` : "";
  // What stopped people in the last 30 days, most common first (one count per person and problem).
  const seen = new Set(), counts = {};
  for (const x of issues) { const k = `${x.email}|${x.category}`; if (seen.has(k)) continue; seen.add(k); counts[x.category] = (counts[x.category] || 0) + 1; }
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return `<article class="card soft"><h3>Started but not registered (${list.length})</h3>
    <p class="small muted">They drop off this list once they finish. Send each group its own reminder.</p>
    ${summary.length ? `<div class="banner warn small"><strong>What stopped people (last 30 days):</strong> ${summary.map(([c, n]) => `${esc(c)} ${n}`).join(" · ")}</div>` : ""}
    ${group(neverOpened, "Never opened the sign-in email", "They asked for the email but never used it. Usually it landed in spam, or they stopped waiting.", "asked", msgEmail)}
    ${group(stopped, "Signed in, but didn't fill in their details", "They got in but stopped at the form, often at the home address.", "signed in", msgDetails)}
  </article>`;
}

function peopleTab(S) {
  if (S.editing) {
    const p = S.editing === "new" ? { role: "rider" } : S.data.profiles.find((x) => x.id === S.editing);
    return `<section class="card"><h2>${S.editing === "new" ? "Add a rider who phoned in" : esc(p.name)}</h2>${profileForm(S, p, { leaderEditing: true, addingForSunday: S.editing === "new" ? S.sunday : null })}
      ${S.editing !== "new" && p.role !== "leader" ? `<hr><h3>Remove ${esc(firstName(p.name))}</h3><p class="small muted">Deletes this person with their requests, availability and rides (for example a test name). Any plan they are in goes back to a draft so you can redo it. This cannot be undone.</p>${btn("Remove " + firstName(p.name), "remove-person", { id: p.id })}` : ""}</section>`;
  }
  const pushOn = new Set(S.data.pushPeople || []);
  const pushMark = (p) => (pushOn.has(p.id) ? " · 🔔 notifications on" : "") + (p.geoSource === "pin" ? " · 📍 pin placed by hand" : p.geoSource === "gps" ? " · 📍 located by phone" : "");
  const drivers = S.data.profiles.filter((p) => isDriver(p) || (p.role === "driver"));
  const riders = S.data.profiles.filter((p) => p.role === "rider");
  const dRow = (d) => {
    const left = daysLeft(d.policeCheckExpiry, S.todayISO);
    const st = d.status === "cleared" ? badge("Cleared", "ok") : badge(d.status === "pending" ? "Needs your approval" : d.status, d.status === "pending" ? "clay" : "red");
    const checkNote = d.policeCheckExpiry ? `check ${left != null && left < 0 ? "EXPIRED " : "to "}${esc(d.policeCheckExpiry)}` : "no check date noted";
    return `<li class="personrow"><div><strong>${esc(d.name)}</strong> ${st}<br><span class="small muted">${esc(d.seats)} seats · ${esc(d.neighbourhood || "no area")} · ${checkNote} · licence ${d.licenceOk ? "✓" : "–"} · insurance ${d.insuranceOk ? "✓" : "–"}${pushMark(d)}</span></div>${btn("Edit / review", "edit", { id: d.id })}</li>`;
  };
  const rRow = (r) => `<li class="personrow"><div><strong>${esc(r.name)}</strong> ${riderBadges(r)}<br><span class="small muted">${esc(r.neighbourhood || "")} · ${r.textsConsentAt ? "texts OK" : "no text consent"}${r.weeklyCheckin ? " · weekly check-in" : ""}${pushMark(r)}</span></div>${btn("Edit", "edit", { id: r.id })}</li>`;
  return `${teamSection(S)}${unregisteredBox(S)}${addressReminderBox(S)}<div class="row wrap">${btn("Add a rider who phoned in", "edit", { id: "new" }, "primary")}</div>
    <h3>Drivers (${drivers.length})</h3><ul class="plain">${drivers.map(dRow).join("") || "<li class='muted'>No drivers yet.</li>"}</ul>
    <h3>Riders (${riders.length})</h3><ul class="plain">${riders.map(rRow).join("") || "<li class='muted'>No riders yet.</li>"}</ul>
    <h3>Keep a copy</h3>
    <article class="card"><p class="small muted">Save a copy of your people and plans in case anything is ever lost. The files contain addresses and phone numbers, so keep them private (for example in your own Google Drive, not shared).</p>
    <div class="row wrap">${btn("Download people list (spreadsheet)", "export-people", {}, "primary")}${btn("Download full backup", "export-backup")}</div></article>`;
}

function alertsTab(S) {
  const open = S.data.alerts.filter((a) => !a.resolved);
  // Done alerts stay (folded away) for 14 days, then drop off the screen. They remain in the database and backups.
  const cutoff = Date.now() - 14 * 86400000;
  const done = S.data.alerts.filter((a) => a.resolved && (!a.createdAt || Date.parse(a.createdAt) >= cutoff));
  const people = ridersMap(S);
  const row = (a) => {
    const day = a.sunday ? fmtDate(a.sunday, { weekday: "long", month: "long", day: "numeric" }) : "";
    const plan = a.sunday ? S.data.plans[a.sunday] : null;
    let body = `<p>${esc(a.message)}</p>`;
    let actions = "";
    if (a.kind === "rider_cancel") {
      const r = people.get(a.riderId);
      const seat = plan?.assignments.find((x) => x.riderId === a.riderId);
      const did = seat?.driverId || a.driverId;
      const d = did ? people.get(did) : null;
      const left = d ? (plan?.assignments || []).filter((x) => x.driverId === did && x.riderId !== a.riderId).length : 0;
      const pickup = seat?.pickupMin != null ? ` (pickup ${esc(fmtMin(seat.pickupMin))})` : ((a.message.match(/\(pickup ([^)]+)\)/) || [])[1] ? ` (pickup ${esc(a.message.match(/\(pickup ([^)]+)\)/)[1])})` : "");
      body = `<p><strong>${esc(r?.name || "A rider")} cancelled their ride for ${esc(day)}.</strong></p>` + (d
        ? `<p>They were in <strong>${esc(d.name)}</strong>'s car${pickup}, so ${esc(firstName(d.name))} now has a free seat${left ? "" : " and no one else to pick up"}. They've been taken out of the plan; if they ask again, they'll need your approval.</p>
           <p class="small"><strong>Already done:</strong> the plan has been updated without ${esc(firstName(r?.name || "them"))}${plan?.status === "approved" && (S.data.pushPeople || []).includes(did) ? `, and ${esc(firstName(d.name))} got a notification on their phone` : ""}.<br>
           <strong>What to do:</strong> 1) Send ${esc(firstName(d.name))} the message below. ${left ? `2) In the Plan tab, tap <strong>Approve & share</strong> so ${esc(firstName(d.name))}'s pickup list and leave time are right, then send the new list from Texts. ` : ""}Then tap <strong>Mark done</strong>.</p>`
        : `<p class="small">They're no longer in the plan, so nothing else needs to change.</p>`);
      if (!a.resolved && d) {
        const msg = T.riderCancelledToDriver(a.sunday, d, r, left);
        body += `<pre class="msg">${esc(msg)}</pre>`;
        actions = btn(`Copy message to ${firstName(d.name)}`, "copy", { text: msg }, "primary");
      }
    } else if (a.kind === "driver_cancel") {
      const d = people.get(a.driverId);
      const riders = (plan?.assignments || []).filter((x) => x.driverId === a.driverId).map((x) => people.get(x.riderId)?.name).filter(Boolean);
      const note = (a.message.match(/Note: (.*)$/) || [])[1];
      body = `<p><strong>${esc(d?.name || "A driver")} can't drive on ${esc(day)}.</strong></p>
        <p>${riders.length ? `${riders.length} ${riders.length === 1 ? "rider needs" : "riders need"} a new driver: ${esc(riders.join(", "))}.` : "They had no riders, so nobody is affected."}${note ? ` Their note: “${esc(note)}”` : ""}</p>
        ${riders.length ? `<p class="small"><strong>Already done:</strong> the plan has moved their riders to the closest drivers with room (anyone who doesn't fit is on the waiting list).<br>
          <strong>What to do:</strong> in the Plan tab, check it and tap <strong>Approve & share</strong>, then send the new messages from Texts. Then tap <strong>Mark done</strong>.</p>` : ""}`;
    }
    return `<article class="card ${a.resolved ? "soft" : "warn"}">${body}
      ${a.resolved ? "" : `<div class="row wrap">${actions}${btn("Mark done", "resolve", { id: a.id })}</div>`}</article>`;
  };
  return `<h3>Needs attention (${open.length})</h3>${open.map(row).join("") || "<p class='muted'>Nothing right now.</p>"}
    ${done.length ? `<details><summary>${done.length} done in the last 14 days</summary>${done.map(row).join("")}</details>` : ""}`;
}

function copyBlock(label, text, note = "") {
  return `<article class="card"><strong>${esc(label)}</strong>${note ? `<p class="small muted">${esc(note)}</p>` : ""}<pre class="msg">${esc(text)}</pre>${btn("Copy", "copy", { text }, "primary")}</article>`;
}

function textsTab(S) {
  const sunday = S.sunday;
  const plan = S.data.plans[sunday];
  const people = ridersMap(S);
  const approved = plan?.status === "approved";
  const chips = S.sundays.map((s) => `<button type="button" class="chip ${s === sunday ? "on" : ""}" data-act="pick-sunday" data-sunday="${esc(s)}">${esc(fmtDate(s))}</button>`).join("");
  const url = S.appUrl || "";
  let html = `<div class="chips">${chips}</div>
    <p class="small muted">Nothing is sent from here. Copy a message and paste it into the group chat or a text. Group messages never include addresses. The driver messages below do, so send each one to that driver only. Only text people who agreed to texts.</p>`;
  html += `<h3>Invitation</h3>`;
  html += copyBlock("Invite people with a car to join the driving team", T.inviteDrivers(url), "For the church group chat or one-to-one. Has no personal details. New drivers are approved by you before they get riders.");
  const changedDays = upcomingDays(8, S.now).filter((d) => serviceFor(d).differs);
  if (changedDays.length) {
    html += `<h3>Service announcements</h3>`;
    for (const d of changedDays) {
      const sv = serviceFor(d);
      html += copyBlock(`${sv.cancelled ? "No service" : sv.title}: ${fmtDate(d, { weekday: "short", month: "short", day: "numeric" })}`, T.serviceAnnouncement(d, url), "For the Chosen group chat. Has no personal details.");
    }
  }
  html += `<h3>Every week</h3>`;
  html += copyBlock("Weekly check-in (Thursday, to the group)", T.weeklyCheckin(sunday, url), "Opt-in riders only. Silence means no ride.");
  html += copyBlock("Reminder the day before (to the group)", T.reminder(sunday));
  if (approved) {
    // Messages are written fresh from the approved plan each time (nothing is stored), and
    // anyone who has cancelled since is left out straight away.
    const cancelled = new Set(S.data.requests.filter((q) => q.sunday === sunday && q.status === "cancelled").map((q) => q.riderId));
    const asg = plan.assignments.filter((a) => !cancelled.has(a.riderId));
    // Cancellations: riders still in the saved plan (older plans), plus those the database took out (alerts).
    const cancelAlerts = (S.data.alerts || []).filter((a) => a.kind === "rider_cancel" && a.sunday === sunday && a.driverId);
    const gone = [...plan.assignments.filter((a) => cancelled.has(a.riderId)),
      ...cancelAlerts.filter((a) => cancelled.has(a.riderId) && !plan.assignments.some((x) => x.riderId === a.riderId)).map((a) => ({ riderId: a.riderId, driverId: a.driverId }))]
      .filter((g, i, all) => all.findIndex((x) => x.riderId === g.riderId) === i);
    // Cancelled, then asked again and approved back in: the driver gets an apology for the back-and-forth.
    const rebooked = new Set(cancelAlerts.filter((a) => !cancelled.has(a.riderId) && asg.some((x) => x.riderId === a.riderId)).map((a) => a.riderId));
    if (gone.length) {
      html += banner("warn", `<strong>${esc(gone.map((a) => people.get(a.riderId)?.name || "A rider").join(", "))} cancelled after this plan was approved.</strong> Their messages are taken out below, and their driver has a cancellation message to send. The other times still come from the approved plan: open the Plan tab and tap <strong>Approve & share</strong> on the updated plan so leave times are right.`);
    }
    html += `<h3>Ride details to each rider</h3>`;
    for (const a of asg) {
      const r = people.get(a.riderId); const d = people.get(a.driverId);
      if (!r || !d) continue;
      html += copyBlock(`${r.name}${r.textsConsentAt ? "" : " (no text consent: call instead)"}`, T.riderDetails(sunday, r, d, a, (S.data.requests.find((q) => q.riderId === r.id && q.sunday === sunday)?.extraPeople || 0) + 1), `${r.phone || "no phone on file"}`);
    }
    html += `<h3>Pickup list to each driver</h3>`;
    for (const did of [...new Set(gone.map((a) => a.driverId))]) {
      const d = people.get(did);
      const left = asg.filter((a) => a.driverId === did).length;
      const names = gone.filter((a) => a.driverId === did).map((a) => people.get(a.riderId));
      if (d) html += copyBlock(left ? `${d.name}: a rider cancelled` : `${d.name}: no pickups now`, names.map((r) => T.riderCancelledToDriver(sunday, d, r, left)).join("\n\n"),
        (d.phone || "no phone on file") + (left ? ". Send this now; send the updated pickup list once you've approved the updated plan." : ". Their rider cancelled, so they have nobody to pick up."));
    }
    const cars = groupCars(asg, S.data.profiles);
    for (const did of [...new Set(cars.map((c) => c.driverId))]) {
      const d = people.get(did);
      const back = asg.filter((a) => a.driverId === did && rebooked.has(a.riderId)).map((a) => firstName(people.get(a.riderId)?.name));
      html += copyBlock(d.name, T.driverRoute(sunday, d, cars.filter((c) => c.driverId === did), people, new Map(S.data.requests.filter((q) => q.sunday === sunday).map((q) => [q.riderId, (q.extraPeople || 0) + 1])), { rebooked: back }), (d.phone || "no phone on file") + ". Send to this driver only. It has addresses and phone numbers.");
    }
    for (const w of plan.waitlist) {
      const r = people.get(w.riderId);
      if (r) html += copyBlock(`${r.name}: still waiting for a seat`, T.waitlisted(sunday, r), r.phone || "");
    }
  } else {
    html += banner("info", "Approve the plan to see each rider's and driver's message.");
  }
  html += lastMinuteCard(S);
  return html;
}

function drivingTab(S) {
  const drives = isDriver(S.me);
  return `<details class="card soft" ${drives ? "" : "open"}><summary>${drives ? "My driving details" : "Do you drive too? Set it up here"}</summary>
    <p class="small muted">Leaders can drive as well. You clear yourself, then you appear as a driver in the plan.</p>${profileForm(S, S.me, { leaderSelf: true })}</details>${drives ? driverView(S) : ""}`;
}

// ---------------------------------------------------------------- services (leader)

function serviceForm(S) {
  const editing = S.editingService;
  const isNew = editing === "new";
  const row = isNew ? null : (S.services || []).find((x) => x.date === editing);
  const svc = isNew ? null : serviceFor(editing);
  const pad = (n) => String(n).padStart(2, "0");
  const c = row?.cutoff ? new Date(row.cutoff) : null;
  const cDate = c ? `${c.getFullYear()}-${pad(c.getMonth() + 1)}-${pad(c.getDate())}` : "";
  const cTime = c ? `${pad(c.getHours())}:${pad(c.getMinutes())}` : "";
  const today = S.todayISO || "";
  return `<form data-form="service" class="stack card">
    <h3>${isNew ? "Add a special service" : `Change ${esc(fmtDate(editing, { weekday: "long", month: "long", day: "numeric" }))}`}</h3>
    ${isNew ? `<label class="field"><span>Date</span><input name="date" type="date" required min="${esc(today)}"></label>`
            : `<input type="hidden" name="date" value="${esc(editing)}">`}
    <label class="field"><span>Name ${isNew ? "" : '<span class="small muted">(optional, e.g. Joint service)</span>'}</span><input name="title" value="${esc(row?.title || "")}" placeholder="${isNew ? "e.g. Christmas Eve service" : "e.g. Joint service"}" ${isNew ? "required" : ""}></label>
    <div class="grid2">
      <label class="field"><span>Service starts</span><input name="time" type="time" required value="${esc(row?.time || (isNew ? "19:00" : S.config.service.time))}"></label>
      <label class="field"><span>Drivers arrive this many minutes before</span><input name="arriveBefore" type="number" min="0" max="90" value="${esc(row?.arriveBeforeMin ?? S.config.service.arriveBeforeMin)}"></label>
    </div>
    <fieldset class="field"><legend>Ride requests close <span class="small muted">(leave empty for noon the day before)</span></legend>
      <div class="grid2"><input name="cutoffDate" type="date" value="${esc(cDate)}" aria-label="Cutoff date"><input name="cutoffTime" type="time" value="${esc(cTime)}" aria-label="Cutoff time"></div>
    </fieldset>
    <label class="field"><span>Note for everyone <span class="small muted">(optional, shown on their dashboard)</span></span><input name="note" value="${esc(row?.note || "")}" placeholder="e.g. Combined service with our sister church"></label>
    <div class="row wrap"><button class="btn primary" type="submit">Save</button>${btn("Cancel", "service-close")}
      ${row ? btn(svc?.sunday ? "Back to the usual Sunday" : "Remove this service", "service-reset", { date: editing }, "link") : ""}</div>
    <p class="small muted">Pickup and leave times for this day are worked out from its start time. If a plan already exists, its times update automatically, ready for you to approve again.</p>
  </form>`;
}

function servicesTab(S) {
  const days = upcomingDays(8, S.now);
  const rows = days.map((day) => {
    const s = serviceFor(day);
    const status = s.cancelled ? badge("No service", "muted") : !s.sunday ? badge("Special", "gold") : s.differs ? badge("Changed", "gold") : badge("Usual", "ok");
    const what = s.cancelled ? "No service" : `${s.differs && s.title !== "Sunday service" ? `${s.title} · ` : ""}${timeLabel(day)}`;
    const buttons = [
      !s.cancelled && btn("Change", "service-edit", { date: day }),
      s.sunday && !s.cancelled && btn("No service", "service-off", { date: day }, "link"),
      s.changed && btn(s.sunday ? "Back to usual" : "Remove", "service-reset", { date: day }, "link"),
    ].filter(Boolean).join("");
    return `<li class="personrow"><div><strong>${esc(fmtDate(day, { weekday: "short", month: "short", day: "numeric" }))}</strong> ${status}<br><span class="small">${esc(what)}${s.customCutoff ? ` · requests close ${esc(cutoffLabel(day))}` : ""}</span></div><div class="row wrap">${buttons}</div></li>`;
  }).join("");
  return `<section>
    <p class="muted">Every Sunday is a service at <strong>${esc(fmtMin(toMin(S.config.service.time)))}</strong> automatically. Change a single day (for example a joint service at 10:00), mark a Sunday as no service, or add a special service on any day. Everyone's dashboard follows straight away, and they decide whether they need a ride or can drive, as usual.</p>
    ${S.editingService ? serviceForm(S) : `<p>${btn("Add a special service", "service-new", {}, "primary")}</p>`}
    <h3>Next 8 weeks</h3>
    <ul class="plain">${rows}</ul>
    <p class="small muted">After a change, send the announcement from the Texts tab to the Chosen group chat.</p>
  </section>`;
}

export function leaderView(S) {
  const openAlerts = S.data.alerts.filter((a) => !a.resolved).length;
  const tabs = [["plan", "Plan"], ["people", "People"], ["alerts", `Alerts${openAlerts ? ` (${openAlerts})` : ""}`], ["texts", "Texts"], ["services", "Services"], ["driving", "My driving"]];
  const body = { plan: planTab, people: peopleTab, alerts: alertsTab, texts: textsTab, services: servicesTab, driving: drivingTab }[S.tab] || planTab;
  return `<nav class="tabs">${tabs.map(([k, l]) => `<button type="button" class="${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${esc(l)}</button>`).join("")}</nav>${pushCard(S)}${body(S)}`;
}

export function tabsFor(S, tabs) {
  return `<nav class="tabs">${tabs.map(([k, l]) => `<button type="button" class="${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${esc(l)}</button>`).join("")}</nav>`;
}

export function roleView(S) {
  if (!S.me) return registerView(S);
  if (S.me.role === "leader") return leaderView(S);
  if (S.me.role === "driver") return tabsFor(S, [["sundays", "My Sundays"], ["details", "My details"]]) + pushCard(S) + driverView(S);
  return tabsFor(S, [["rides", "Rides"], ["details", "My details"]]) + pushCard(S) + riderView(S);
}

// ---------------------------------------------------------------- last-minute help

function lastMinuteCard(S) {
  const sunday = S.sunday;
  const people = ridersMap(S);
  const url = S.appUrl || "";
  const form = `<form data-form="help" class="stack">
      <label class="field"><span>Rider's name</span><input name="helpName" required value="${esc(S.help?.newRider?.name || "")}" placeholder="e.g. Jo"></label>
      <div class="field addr">
        <label for="help-addr">Where to pick them up</label>
        <input id="help-addr" name="address" required value="${esc(S.help?.newRider?.address || "")}" autocomplete="off" placeholder="Start typing, e.g. 639 Addie Crescent" aria-autocomplete="list" aria-controls="help-suggest">
        <div class="suggest" id="help-suggest" role="listbox" hidden></div>
        <p class="small muted addr-status" aria-live="polite">Pick the address from the list. It's checked to the house number, like everyone else's.</p>
        <input type="hidden" name="pickedAddress" value=""><input type="hidden" name="pickedLat" value=""><input type="hidden" name="pickedLng" value="">
      </div>
      <label class="field"><span>Their phone <span class="small muted">(optional; only the driver who says yes sees it)</span></span><input name="helpPhone" type="tel" inputmode="tel" value="${esc(S.help?.newRider?.phone || "")}" placeholder="306-555-0142"></label>
      <label class="field"><span>Seats needed (the rider plus anyone with them)</span><input name="helpSeats" type="number" min="1" max="10" value="${esc(S.help?.seats || 1)}"></label>
      <button class="btn primary" type="submit">Find the closest drivers</button>
    </form>`;

  // Step 2: choose who to ask, then send it to their dashboards.
  let results = "";
  const h = S.help;
  if (h?.result && h.sunday === sunday) {
    const r = h.result;
    const rows = r.list.map((x, i) => {
      const d = x.driver;
      const status = x.driving
        ? badge(x.fits ? `Driving this day · ${x.freeSeats} free seat${x.freeSeats === 1 ? "" : "s"}` : "Driving this day · car full", x.fits ? "ok" : "muted")
        : badge("Not down to drive this day", "muted");
      return `<li class="helper"><label class="check"><input type="checkbox" name="askDriver" value="${esc(d.id)}" ${i < 3 && x.fits ? "checked" : ""}>
        <span><strong>${esc(d.name)}</strong> ${status}<br>
        <span class="small">About <strong>${esc(x.awayMin)} min</strong> from ${esc(firstName(h.name))} · ${esc(x.detourMin)} min out of their way from home${d.phone ? ` · ${esc(d.phone)}` : ""}</span></span></label></li>`;
    }).join("");
    results = `<h4>Closest drivers for ${esc(h.name)}${h.neighbourhood ? ` (${esc(h.neighbourhood)})` : ""}</h4>
      <p class="small muted">Suggested pickup around <strong>${esc(fmtMin(r.pickupMin))}</strong> to reach church on time. Only cleared drivers with a confirmed address are listed, closest first, with those already driving that day at the top. The three closest with room are ticked.</p>
      ${r.travelNote ? banner("warn", esc(r.travelNote)) : ""}
      ${rows ? `<form data-form="help-ask" class="stack"><ol class="plain helpers">${rows}</ol>
        <button class="btn primary" type="submit">Ask the ticked drivers in the app</button>
        <p class="small muted">They'll see it on their dashboard and tap Yes or No. The first yes gets the ride, and only that driver sees the address${h.phone ? " and phone number" : ""}.</p></form>`
        : `<p class="muted">No cleared drivers with a confirmed address yet.</p>`}
`;
  }

  // Requests already sent, with each driver's answer.
  const reqs = (S.data.helpRequests || []).filter((x) => x.sunday === sunday && x.status !== "cancelled");
  const answerBadge = (a) => (a === "yes" ? badge("Yes", "ok") : a === "no" ? badge("No", "muted") : badge("No reply yet", "gold"));
  const sent = reqs.map((x) => {
    const winner = x.acceptedBy ? people.get(x.acceptedBy) : null;
    const head = `<strong>${esc(x.riderName)}</strong>${x.neighbourhood ? ` · ${esc(x.neighbourhood)}` : ""} · pickup around ${esc(fmtMin(x.pickupMin))}${x.seats > 1 ? ` · ${esc(x.seats)} seats` : ""}`;
    const state = winner ? badge(`Covered by ${firstName(winner.name)}`, "ok") : badge("Waiting for a yes", "gold");
    const asks = x.asks.map((a) => {
      const d = people.get(a.driverId);
      if (!d) return "";
      const nudge = !winner && !a.answer ? `<details><summary class="small">Text to ${esc(firstName(d.name))}</summary><pre class="msg">${esc(T.helpAskText(sunday, d, x.riderName, x.neighbourhood, x.seats, a.awayMin, x.pickupMin, url))}</pre>${btn("Copy", "copy", { text: T.helpAskText(sunday, d, x.riderName, x.neighbourhood, x.seats, a.awayMin, x.pickupMin, url) })}</details>` : "";
      return `<li><div class="row wrap"><span>${esc(d.name)}</span>${answerBadge(a.answer)}${a.driverId === x.acceptedBy ? badge("Has the ride", "ok") : ""}</div>${nudge}</li>`;
    }).join("");
    const confirmMsg = winner ? T.helpConfirmText(sunday, winner, x) : "";
    return `<article class="card ${winner ? "soft" : "warn"}"><div class="row wrap">${head} ${state}</div>
      <ul class="plain asks">${asks}</ul>
      ${winner ? `<p class="small">${esc(firstName(winner.name))} can see the address${x.riderPhone ? " and phone number" : ""} in the app. If ${esc(firstName(x.riderName))} needs to be in a plan, add them under <strong>People</strong>.</p>
        <details><summary class="small">Thank-you text to ${esc(firstName(winner.name))} (with the address)</summary><pre class="msg">${esc(confirmMsg)}</pre>${btn("Copy", "copy", { text: confirmMsg })}</details>` : ""}
      <div class="row wrap">${btn("Cancel this request", "help-cancel", { id: x.id }, "link")}</div></article>`;
  }).join("");

  return `<article class="card"><strong>Last-minute: find a driver</strong>
    <p class="small muted">For someone who still needs a ride. The app finds the cleared drivers closest to them, using the same address check and road times as the plan, then asks them in the app.</p>
    ${sent ? `<h4>Requests sent (${reqs.length})</h4>${sent}<h4>New request</h4>` : ""}
    ${form}${results}</article>`;
}
