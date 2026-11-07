// Glue between the data (profiles, requests, availability) and the matching engine.
// Used by the leader's screen. Everything async here only waits on the routing service.

import { plan, evaluate, pointsFor } from "./matching.js";
import { buildTravel } from "./routing.js";
import { asDriver, isDriver, driverAvailable } from "./models.js";
import { toMin } from "./dates.js";
import { isConfirmed } from "./geo.js";
import { withVan, planHome, homeDepartFor } from "./van.js";

export function matchOptions(config) {
  return {
    ...config.matching,
    serviceTime: config.service.time,
    arriveBeforeMin: config.service.arriveBeforeMin,
    readyBy: config.service.readyBy,
    readyBufferMin: config.service.readyBufferMin,
  };
}

/**
 * Only CONFIRMED home addresses are used for matching and timing. Anyone else is treated as
 * "not located": riders go on the waiting list and drivers are left out, each with the reason.
 * Nothing is ever timed from a guessed or approximate location.
 */
const located = (p) => (isConfirmed(p) ? p : { ...p, lat: null, lng: null, unconfirmed: true });

/** Who is asking for a ride on this Sunday, who could drive. */
export function sundayPeople(data, sunday) {
  const byId = new Map(data.profiles.map((p) => [p.id, located(p)]));
  const riders = data.requests
    .filter((r) => r.sunday === sunday && r.status !== "cancelled")
    .map((r) => ({ ...byId.get(r.riderId), rideHome: r.rideHome, requestNote: r.note, extraPeople: r.extraPeople || 0, canSplit: !!r.canSplit }))
    .filter((r) => r.id);
  const drivers = withVan(data.profiles.filter(isDriver).map((p) => asDriver(located(p), data.weeks, sunday)), data, sunday);
  return { riders, drivers };
}

/**
 * Road times come from OSRM (real streets, bridges and speed limits, but no traffic lights or
 * delays). Every leg gets a safety margin on top: a percentage plus a fixed minute.
 * If real road times are unavailable, the straight-line guess gets a bigger margin and the
 * leader is told; such a plan must be re-drafted before it can be approved.
 */
export function withMargin(rawTravel, source, m = {}) {
  const pct = source === "osrm" ? (m.trafficPct ?? 20) : (m.estimatePct ?? 40);
  const add = m.legBufferMin ?? 1;
  return (a, b) => (a.id === b.id ? 0 : rawTravel(a, b) * (1 + pct / 100) + add);
}

async function travelFor(people, church, config, fetchFn) {
  const pts = pointsFor({ church, ...people });
  const t = await buildTravel(pts, {
    enabled: config.routing.enabled,
    baseUrl: config.routing.osrmUrl,
    ...(fetchFn ? { fetchFn } : {}),
    ...(fetchFn ? { delayMs: 0 } : {}),
  });
  return { ...t, travel: withMargin(t.travel, t.source, config.matching) };
}

/** The van's rides home for a day (null if there's no van or nobody asked). */
function homeFor(people, church, config, travel, data, sunday) {
  const van = people.drivers.find((d) => d.isVehicle);
  return planHome({ church, van, riders: people.riders, travel, departMin: homeDepartFor(data, sunday, config.service.time), stopMin: config.matching.stopMin ?? 3 });
}

/** Draft a plan. `keep` = assignments to leave alone (used after a cancellation). */
export async function draftPlan({ data, sunday, church, config, keep = [], fetchFn }) {
  const people = sundayPeople(data, sunday);
  const t = await travelFor(people, church, config, fetchFn);
  const result = plan({ church, ...people, travel: t.travel, date: sunday, options: matchOptions(config), keep });
  return { ...result, home: homeFor(people, church, config, t.travel, data, sunday), travelSource: t.source, travelNote: t.note };
}

/** Re-time and re-check a plan after the leader moves someone by hand. */
export async function recompute({ data, sunday, church, config, assignments, waitlist, fetchFn }) {
  const people = sundayPeople(data, sunday);
  const t = await travelFor(people, church, config, fetchFn);
  const ev = evaluate({ church, ...people, assignments, travel: t.travel, date: sunday, options: matchOptions(config) });
  return { ...ev, waitlist, home: homeFor(people, church, config, t.travel, data, sunday), travelSource: t.source, travelNote: t.note };
}

/**
 * Move a rider (or the part of a group in one car) to another car ("driverId|trip") or the waitlist ("wait").
 * `from` is where they are now: "wait" or "driverId|trip". Seats move with them.
 */
export function applyMove({ assignments, waitlist }, riderId, target, from, reason = "Moved to the waitlist by the leader.") {
  let a = assignments.map((x) => ({ ...x }));
  let w = waitlist.map((x) => ({ ...x }));
  let seats = 1;
  if (from === "wait") {
    const e = w.find((x) => x.riderId === riderId);
    seats = e?.seats ?? 1;
    w = w.filter((x) => x.riderId !== riderId);
  } else {
    const idx = a.findIndex((x) => x.riderId === riderId && `${x.driverId}|${x.trip}` === from);
    if (idx >= 0) { seats = a[idx].seats ?? 1; a.splice(idx, 1); }
  }
  if (target === "wait") {
    const e = w.find((x) => x.riderId === riderId);
    if (e) e.seats = (e.seats ?? 1) + seats;
    else w.push({ riderId, seats, reason });
  } else {
    const [driverId, trip] = target.split("|");
    const t = Number(trip) || 1;
    const same = a.find((x) => x.riderId === riderId && x.driverId === driverId && x.trip === t);
    if (same) same.seats = (same.seats ?? 1) + seats;
    else a.push({ riderId, driverId, trip: t, seats });
    // Moving a car's worth of a group drops its old time/order so it is re-timed.
    a = a.map((x) => (x.riderId === riderId ? { ...x, order: undefined } : x));
  }
  return { assignments: a.map(({ riderId, driverId, trip, seats, order }) => ({ riderId, driverId, trip, seats, order })), waitlist: w };
}

/** A driver can't make it: keep everyone else where they are, re-place the affected riders. */
export async function reassignDriver({ data, sunday, church, config, current, driverId, fetchFn }) {
  const weeks = [
    ...data.weeks.filter((w) => !(w.driverId === driverId && w.sunday === sunday)),
    { driverId, sunday, available: false },
  ];
  const keep = current.assignments.filter((a) => a.driverId !== driverId);
  const result = await draftPlan({ data: { ...data, weeks }, sunday, church, config, keep, fetchFn });
  return { ...result, weeks };
}

/** Group saved assignments into cars for display (uses the saved times, no routing needed). */
export function groupCars(assignments, drivers) {
  const cars = new Map();
  for (const a of assignments) {
    const key = `${a.driverId}|${a.trip || 1}`;
    if (!cars.has(key)) cars.set(key, { driverId: a.driverId, trip: a.trip || 1, stops: [] });
    cars.get(key).stops.push(a);
  }
  const order = new Map(drivers.map((d, i) => [d.id, i]));
  return [...cars.values()]
    .map((c) => ({ ...c, stops: c.stops.sort((x, y) => (x.order ?? 0) - (y.order ?? 0)) }))
    .sort((a, b) => (order.get(a.driverId) ?? 99) - (order.get(b.driverId) ?? 99) || a.trip - b.trip);
}

/**
 * Last-minute help: who is best placed to pick up one rider?
 * Only CLEARED drivers with a CONFIRMED home address are considered, and the rider's location
 * must be confirmed too (never a guess). Uses the same road times and safety margin as the plan.
 * rider: { name, lat, lng, neighbourhood }. assignments: the current plan for that Sunday.
 * Returns { pickupMin, list: [{ driver, awayMin, detourMin, freeSeats, driving, fits }] }, best first:
 * drivers already driving that Sunday with room, then others with room, then by fewest minutes out of their way.
 */
export async function rankHelpers({ data, sunday, church, config, rider, seats = 1, assignments = [], fetchFn }) {
  if (!church) throw new Error("The church location isn't set.");
  if (!isConfirmed(rider)) throw new Error("This rider's address isn't confirmed, so we can't work out who is closest. Confirm the address first.");
  const drivers = data.profiles.filter(isDriver).filter((d) => !d.isVehicle && d.status === "cleared" && isConfirmed(d) && d.seats > 0);
  const rn = { id: "R:help", lat: rider.lat, lng: rider.lng };
  const cn = { id: "church", lat: church.lat, lng: church.lng };
  const node = (d) => ({ id: `D:${d.id}`, lat: d.lat, lng: d.lng });
  const t = await buildTravel([cn, rn, ...drivers.map(node)], {
    enabled: config.routing.enabled, baseUrl: config.routing.osrmUrl,
    ...(fetchFn ? { fetchFn, delayMs: 0 } : {}),
  });
  const travel = withMargin(t.travel, t.source, config.matching);
  const stop = config.matching.stopMin ?? 3;
  const target = toMin(config.service.time) - config.service.arriveBeforeMin;
  const pickupMin = Math.floor((target - travel(rn, cn) - stop) / 5) * 5;
  const list = drivers.map((d) => {
    const dn = node(d);
    const awayMin = travel(dn, rn);
    const detourMin = Math.max(0, awayMin + stop + travel(rn, cn) - travel(dn, cn));
    const driving = driverAvailable(d, data.weeks, sunday);
    const used = assignments.filter((a) => a.driverId === d.id && (a.trip || 1) === 1).reduce((n, a) => n + (a.seats ?? 1), 0);
    const freeSeats = Math.max(0, (d.seats || 0) - used);
    return { driver: d, awayMin: Math.round(awayMin), detourMin: Math.round(detourMin), freeSeats, driving, fits: freeSeats >= seats };
  }).sort((a, b) => (b.driving && b.fits) - (a.driving && a.fits) || b.fits - a.fits || a.detourMin - b.detourMin);
  return { pickupMin, list, travelSource: t.source, travelNote: t.note };
}
