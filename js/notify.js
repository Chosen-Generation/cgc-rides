// The phone notifications sent when a leader approves a plan: only to people whose ride changed.

import { fmtMin } from "./dates.js";
import { dayLabel } from "./services.js";

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "Your driver";

/**
 * before: the plan as last saved (or null); after: { assignments, waitlist }.
 * Returns [{ profileId, title, body, tag }]. If the plan wasn't approved before, everyone in it
 * hears; otherwise only those whose driver, pickup time or route changed.
 */
export function approvalPings({ before, after, sunday, profilesById }) {
  const wasApproved = before?.status === "approved";
  const old = wasApproved ? before.assignments || [] : [];
  const day = dayLabel(sunday, { long: true });
  const tag = `ride-${sunday}`;
  const out = [];
  const firstTrip = (list, riderId) => list.filter((a) => a.riderId === riderId).sort((a, b) => a.trip - b.trip)[0];

  // Riders
  const riders = new Set(after.assignments.map((a) => a.riderId));
  for (const rid of riders) {
    const now = firstTrip(after.assignments, rid);
    const was = firstTrip(old, rid);
    if (was && was.driverId === now.driverId && was.pickupMin === now.pickupMin) continue;
    const d = profilesById.get(now.driverId);
    const when = now.pickupMin != null ? ` at ${fmtMin(now.pickupMin)}` : "";
    out.push({ profileId: rid, tag, title: was ? "Your ride has changed" : "Your ride is confirmed",
      body: `${first(d?.name)}${d?.isVehicle ? " (church van)" : ""} will pick you up${when} for ${day}. Open the app for details.` });
  }
  for (const a of old) {
    if (riders.has(a.riderId) || out.some((o) => o.profileId === a.riderId)) continue;
    const waiting = (after.waitlist || []).some((w) => w.riderId === a.riderId);
    out.push({ profileId: a.riderId, tag, title: "Your ride has changed",
      body: waiting ? `We couldn't keep your seat for ${day}. The transport team will be in touch.` : `You no longer have a ride booked for ${day}. Open the app for details.` });
  }

  // Drivers
  const route = (list, did) => list.filter((a) => a.driverId === did).map((a) => `${a.riderId}@${a.pickupMin}#${a.trip}`).sort().join(",");
  const drivers = new Set([...after.assignments.map((a) => a.driverId), ...old.map((a) => a.driverId)]);
  for (const did of drivers) {
    // The church van: the person driving it that day gets its route.
    const dv = profilesById.get(did);
    const to = dv?.isVehicle ? dv.vanDriverId : did;
    if (!to) continue;
    const vanWord = dv?.isVehicle ? " in the church van" : "";
    const fromWord = dv?.isVehicle && dv.vanStart !== "home" ? "the church (with the van)" : "home";
    const now = after.assignments.filter((a) => a.driverId === did);
    if (wasApproved && route(old, did) === route(after.assignments, did)) continue;
    if (!now.length) {
      out.push({ profileId: to, tag: `route-${sunday}${vanWord ? "-van" : ""}`, title: "Your route has changed", body: `You no longer have anyone to pick up${vanWord} for ${day}. Thank you!` });
      continue;
    }
    const people = now.reduce((n, a) => n + (a.seats ?? 1), 0);
    const leave = Math.min(...now.filter((a) => a.trip === Math.min(...now.map((x) => x.trip))).map((a) => a.departMin ?? Infinity));
    const changed = wasApproved && old.some((a) => a.driverId === did);
    out.push({ profileId: to, tag: `route-${sunday}${vanWord ? "-van" : ""}`, title: changed ? "Your route has changed" : "Your route is ready",
      body: `${people} ${people === 1 ? "person" : "people"} to pick up${vanWord} for ${day}.${Number.isFinite(leave) ? ` Leave ${fromWord} by ${fmtMin(leave)}.` : ""} Open the app for the list.` });
  }
  return out;
}
