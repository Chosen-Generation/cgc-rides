// The matching engine. Pure functions: no network, no DOM, no clock. Everything it needs
// is passed in, so it can be tested in Node.
//
// plan()     decides who rides with whom (the draft the leader reviews).
// evaluate() takes ANY set of assignments (drafted or moved by hand) and works out the
//            stop order, pickup times, "be ready by" times and rule warnings.
//
// How the draft is made (cheapest insertion):
//   1. Only cleared, available drivers with a current police check take part.
//   2. Riders are placed priority first, then under-18 riders, then the farthest from church first.
//   3. Each rider goes to the car where they add the fewest minutes to the drive to
//      church, as long as the car has a free seat and the detour is within limits.
//   4. Riders left over go on a driver's SECOND trip (only for drivers who offered one,
//      and only once their first trip is full).
//   5. Anyone still left is waitlisted, with the reason written out.
// Pickup times are worked backward from "arrive at church" (service time minus 15 min).

import { toMin } from "./dates.js";

export const DEFAULTS = {
  stopMin: 3,
  unloadMin: 2,
  maxDetourMin: 35,
  maxRouteMin: 75,
  earliestPickup: "09:30",
  serviceTime: "11:45",
  arriveBeforeMin: 15,
  readyBy: null, // optional fixed ceiling such as "10:45"; null = work it out from the route
  readyBufferMin: 5, // be ready this long before the driver is due
  vanPreferMin: 12, // the church van is preferred by this many minutes, so it takes clusters and fewer cars go out
};

const opts = (o) => ({ ...DEFAULTS, ...(o || {}) });
const floor5 = (m) => Math.floor(m / 5) * 5;
/** Seats a request needs: the rider plus anyone coming with them. */
export const need = (r) => 1 + Math.max(0, Number(r.extraPeople) || 0);
const stopSeats = (s) => s.seats ?? need(s.rider);
const load = (trip) => trip.stops.reduce((n, s) => n + stopSeats(s), 0);
const hasLoc = (p) => p && p.lat != null && p.lng != null;

export const churchNode = (c) => ({ id: "church", lat: c.lat, lng: c.lng });
export const driverNode = (d) => ({ id: `D:${d.id}`, lat: d.lat, lng: d.lng });
export const riderNode = (r, church) =>
  hasLoc(r) ? { id: `R:${r.id}`, lat: r.lat, lng: r.lng } : { id: `R:${r.id}`, lat: church.lat, lng: church.lng };

/** Every point the router needs times between (only those with a location). */
export function pointsFor({ church, drivers, riders }) {
  const pts = [];
  if (hasLoc(church)) pts.push(churchNode(church));
  for (const d of drivers) if (hasLoc(d)) pts.push(driverNode(d));
  for (const r of riders) if (hasLoc(r)) pts.push(riderNode(r, church));
  return pts;
}

/**
 * Vetting is done by the transport leader (licence, insurance, police check, anything else
 * the church requires). The app's only rule is the leader's decision: status "cleared".
 * Licence / insurance / check-expiry fields are optional notes for the leader's own records.
 */
export const isVetted = (d) => d.status === "cleared";

/** Why a driver can't carry anyone this Sunday (null = fine). */
export function driverIssue(d, sundayISO) {
  if (d.isVehicle && d.noVanDriver) return "No van driver chosen for this day (choose one above the plan)";
  if (d.drivingVan) return "Driving the church van this day";
  if (d.status !== "cleared") return d.status === "suspended" ? "Suspended" : "Not cleared yet";
  if (!d.available) return "Not available this Sunday";
  if (!(d.seats > 0)) return "No seats offered";
  if (!hasLoc(d)) return d.unconfirmed ? "Home address not confirmed (ask them to confirm it in My details)" : "Home address not located";
  return null;
}

/** Rule clash between one driver and one rider (null = fine). */
export function pairIssue(d, r, sundayISO) {
  if (r.minor && !isVetted(d)) return "minor_check";
  return null;
}

/** "Be ready by": the estimated pickup minus a small buffer (and never later than a fixed ceiling, if one is set). */
export function readyByFor(pickupMin, o) {
  const x = opts(o);
  const t = floor5(pickupMin - x.readyBufferMin);
  return x.readyBy ? Math.min(toMin(x.readyBy), t) : t;
}

// ---------- route maths ----------

function tripMinutes(trip, cn, travel, o) {
  let t = 0;
  let prev = trip.start;
  for (const s of trip.stops) {
    t += travel(prev, s.node) + o.stopMin;
    prev = s.node;
  }
  return t + travel(prev, cn);
}

function insertionDelta(trip, pos, node, cn, travel, o) {
  const prev = pos === 0 ? trip.start : trip.stops[pos - 1].node;
  const next = pos === trip.stops.length ? cn : trip.stops[pos].node;
  return travel(prev, node) + o.stopMin + travel(node, next) - travel(prev, next);
}

/** Work backward from the arrival time. trips are in the order they are driven. */
function scheduleTrips(trips, cn, travel, o, target) {
  const res = new Array(trips.length);
  let arrive = target;
  for (let i = trips.length - 1; i >= 0; i--) {
    const t = trips[i];
    const n = t.stops.length;
    const pick = new Array(n);
    let dep = arrive - travel(t.stops[n - 1].node, cn);
    for (let k = n - 1; k >= 0; k--) {
      pick[k] = dep - o.stopMin;
      if (k > 0) dep = pick[k] - travel(t.stops[k - 1].node, t.stops[k].node);
    }
    const depart = pick[0] - travel(t.start, t.stops[0].node);
    res[i] = { pickups: pick, departMin: depart, arriveMin: arrive };
    arrive = depart - o.unloadMin; // the earlier trip must be unloaded before this one leaves
  }
  return res;
}

function orderStops(start, items, cn, travel, o) {
  const sorted = [...items].sort((a, b) => travel(b.node, cn) - travel(a.node, cn));
  const out = [];
  for (const it of sorted) {
    let best = 0;
    let bestCost = Infinity;
    for (let p = 0; p <= out.length; p++) {
      const c = insertionDelta({ start, stops: out }, p, it.node, cn, travel, o);
      if (c < bestCost) {
        bestCost = c;
        best = p;
      }
    }
    out.splice(best, 0, it);
  }
  return out;
}

// ---------- evaluate: times and warnings for any set of assignments ----------

export function evaluate({ church, drivers, riders, assignments, travel, date, options }) {
  const o = opts(options);
  const target = toMin(o.serviceTime) - o.arriveBeforeMin;
  const earliest = toMin(o.earliestPickup);
  const cn = churchNode(church);
  const dById = new Map(drivers.map((d) => [d.id, d]));
  const rById = new Map(riders.map((r) => [r.id, r]));
  const warnings = [];

  const byDriver = new Map(); // driverId -> Map(trip -> assignment[])
  for (const a of assignments) {
    if (!dById.has(a.driverId) || !rById.has(a.riderId)) continue;
    if (!byDriver.has(a.driverId)) byDriver.set(a.driverId, new Map());
    const m = byDriver.get(a.driverId);
    const tn = a.trip || 1;
    if (!m.has(tn)) m.set(tn, []);
    m.get(tn).push(a);
  }

  const trips = [];
  const out = [];
  for (const [driverId, tmap] of byDriver) {
    const d = dById.get(driverId);
    const dn = hasLoc(d) ? driverNode(d) : cn;
    const issue = driverIssue(d, date);
    if (issue) warnings.push({ code: "driver_issue", driverId, text: `${d.name}: ${issue}.` });

    const tripNums = [...tmap.keys()].sort((a, b) => a - b);
    const built = tripNums.map((tn) => {
      const list = tmap.get(tn);
      const items = list.map((a) => {
        const r = rById.get(a.riderId);
        if (!hasLoc(r)) warnings.push({ code: "no_location", riderId: r.id, text: `${r.name}: home address not confirmed, so no pickup time can be worked out. Move them to the waiting list or confirm the address first.` });
        const pi = pairIssue(d, r, date);
        if (pi === "minor_check") warnings.push({ code: "minor_check", riderId: r.id, driverId, text: `${r.name} is under 18 and ${d.name} has no current police check.` });
        return { id: r.id, rider: r, node: riderNode(r, church), order: a.order, seats: a.seats ?? need(r) };
      });
      const ordered = items.every((i) => typeof i.order === "number")
        ? [...items].sort((a, b) => a.order - b.order)
        : orderStops(tn === 1 ? dn : cn, items, cn, travel, o);
      const used = items.reduce((n, i) => n + i.seats, 0);
      if (used > (d.seats || 0)) {
        warnings.push({ code: "over_seats", driverId, text: `${d.name} has ${d.seats || 0} seat(s) but trip ${tn} needs ${used} (riders plus the people coming with them).` });
      }
      return { tn, start: tn === 1 ? dn : cn, stops: ordered };
    });

    const sched = scheduleTrips(built, cn, travel, o, target);
    built.forEach((t, i) => {
      const s = sched[i];
      const stops = t.stops.map((st, k) => {
        const pickupMin = floor5(s.pickups[k]);
        return {
          riderId: st.id,
          order: k,
          pickupMin,
          readyByMin: readyByFor(pickupMin, o),
          seats: st.seats,
        };
      });
      if (i === 0 && s.pickups[0] < earliest) {
        warnings.push({
          code: "early_pickup",
          driverId,
          text: `${d.name}'s first pickup would be before ${o.earliestPickup}. Consider fewer riders on this car.`,
        });
      }
      trips.push({
        driverId,
        trip: t.tn,
        riderIds: stops.map((x) => x.riderId),
        stops,
        departMin: floor5(s.departMin),
        arriveMin: s.arriveMin,
        routeMin: Math.round(s.arriveMin - s.departMin),
      });
      for (const st of stops) out.push({ riderId: st.riderId, driverId, trip: t.tn, order: st.order, seats: st.seats, pickupMin: st.pickupMin, readyByMin: st.readyByMin, arriveMin: s.arriveMin, departMin: floor5(s.departMin) });
    });
  }
  // A group split across cars when they asked to stay together is flagged, not blocked.
  const carsPerRider = new Map();
  for (const a of out) carsPerRider.set(a.riderId, (carsPerRider.get(a.riderId) || 0) + 1);
  for (const [rid, n] of carsPerRider) {
    const r = rById.get(rid);
    if (n > 1 && !r.canSplit) warnings.push({ code: "split_not_ok", riderId: rid, text: `${r.name}'s group is split across ${n} cars, but they didn't say that's OK. Check with them before approving.` });
  }
  return { trips, assignments: out, warnings };
}

// ---------- plan: the automatic draft ----------

export function plan({ church, drivers, riders, travel, date, options, keep = [] }) {
  if (!church || !hasLoc(church)) throw new Error("church_location_missing");
  const o = opts(options);
  const target = toMin(o.serviceTime) - o.arriveBeforeMin;
  const earliest = toMin(o.earliestPickup);
  const cn = churchNode(church);

  const excludedDrivers = [];
  const state = new Map();
  for (const d of drivers) {
    const issue = driverIssue(d, date);
    if (issue) {
      excludedDrivers.push({ driverId: d.id, name: d.name, reason: issue });
      continue;
    }
    const dn = driverNode(d);
    state.set(d.id, { d, trips: [{ start: dn, stops: [] }, { start: cn, stops: [] }] });
  }
  const states = [...state.values()];

  // Assignments the leader already settled (used when re-planning after a cancellation).
  const riderById = new Map(riders.map((r) => [r.id, r]));
  const keptSeats = new Map();
  for (const k of keep) {
    const st = state.get(k.driverId);
    const r = riderById.get(k.riderId);
    if (!st || !r || !hasLoc(r)) continue;
    const trip = st.trips[(k.trip || 1) - 1];
    const seats = k.seats ?? need(r);
    if (!trip || load(trip) + seats > st.d.seats || trip.stops.some((x) => x.id === r.id)) continue;
    trip.stops.push({ id: r.id, rider: r, node: riderNode(r, church), order: k.order ?? 0, seats });
    keptSeats.set(r.id, (keptSeats.get(r.id) || 0) + seats);
  }
  for (const st of states) for (const t of st.trips) t.stops.sort((a, b) => a.order - b.order);

  const totalSeats = states.reduce((n, s) => n + s.d.seats * (s.d.secondTrip ? 2 : 1), 0);

  const feasible = (st) => {
    const present = st.trips.filter((t) => t.stops.length);
    if (!present.length) return true;
    const sch = scheduleTrips(present, cn, travel, o, target);
    return sch[0].pickups[0] >= earliest;
  };

  /**
   * Try to seat `want` seats of one rider on trip tripIdx. whole = all `want` in one car;
   * otherwise a car takes as many as it has room for. Returns the seats placed (0 = none).
   */
  const tryPlace = (rider, tripIdx, want, whole) => {
    const node = riderNode(rider, church);
    const cands = [];
    for (const st of states) {
      if (pairIssue(st.d, rider, date)) continue;
      const trip = st.trips[tripIdx];
      if (trip.stops.some((x) => x.id === rider.id)) continue;
      const free = st.d.seats - load(trip);
      const free0 = st.d.seats - load(st.trips[0]);
      if (tripIdx === 1 && (!st.d.secondTrip || !st.trips[0].stops.length || (whole ? free0 >= want : free0 > 0))) continue;
      const chunk = whole ? want : Math.min(want, free);
      if (chunk < 1 || chunk > free) continue;
      const base = tripMinutes(trip, cn, travel, o);
      let pos = 0;
      let cost = Infinity;
      for (let p = 0; p <= trip.stops.length; p++) {
        const c = insertionDelta(trip, p, node, cn, travel, o);
        if (c < cost) {
          cost = c;
          pos = p;
        }
      }
      // The van starts at church, so any rider is a round trip for it: only the total route limit applies.
      if ((!st.d.isVehicle && cost > o.maxDetourMin) || base + cost > o.maxRouteMin) continue;
      cands.push({ st, trip, pos, cost, chunk, rank: cost - (st.d.isVehicle ? o.vanPreferMin : 0) });
    }
    cands.sort(
      (a, b) =>
        (whole ? 0 : b.chunk - a.chunk) ||
        a.rank - b.rank ||
        a.trip.stops.length - b.trip.stops.length ||
        String(a.st.d.id).localeCompare(String(b.st.d.id))
    );
    for (const c of cands) {
      c.trip.stops.splice(c.pos, 0, { id: rider.id, rider, node, seats: c.chunk });
      if (feasible(c.st)) return c.chunk;
      c.trip.stops.splice(c.pos, 1);
    }
    return 0;
  };

  const waitlist = [];
  const located = [];
  for (const r0 of riders) {
    const remaining = need(r0) - (keptSeats.get(r0.id) || 0);
    if (remaining <= 0) continue;
    const r = keptSeats.has(r0.id) ? { ...r0, extraPeople: remaining - 1 } : r0;
    if (!hasLoc(r)) waitlist.push({ riderId: r.id, seats: remaining, reason: r.unconfirmed
      ? "Home address not confirmed, so we can't work out a safe pickup time. Ask them to confirm it in My details (or fix it under People), then draft again."
      : "We couldn't locate this address. Fix the address, then run the plan again." });
    else located.push(r);
  }
  const constraint = (r) => (r.minor ? 1 : 0);
  located.sort(
    (a, b) =>
      (b.priority ? 1 : 0) - (a.priority ? 1 : 0) ||
      constraint(b) - constraint(a) ||
      travel(riderNode(b, church), cn) - travel(riderNode(a, church), cn) ||
      String(a.id).localeCompare(String(b.id))
  );

  let left = [];
  for (const r of located) if (!tryPlace(r, 0, need(r), true)) left.push(r);
  const still = [];
  for (const r of left) if (!tryPlace(r, 1, need(r), true)) still.push(r);

  const maxSeats = states.length ? Math.max(...states.map((s) => s.d.seats)) : 0;
  const diagnose = (r) => {
    if (!states.length) return "No cleared, available drivers this Sunday.";
    const node = riderNode(r, church);
    const verdicts = states.map((st) => {
      if (pairIssue(st.d, r, date)) return "pair";
      if (need(r) > st.d.seats) return "toobig";
      for (const idx of [0, 1]) {
        const trip = st.trips[idx];
        if (idx === 1 && (!st.d.secondTrip || !st.trips[0].stops.length || st.d.seats - load(st.trips[0]) >= need(r))) continue;
        if (load(trip) + need(r) > st.d.seats) continue;
        const base = tripMinutes(trip, cn, travel, o);
        let cost = Infinity;
        for (let p = 0; p <= trip.stops.length; p++) cost = Math.min(cost, insertionDelta(trip, p, node, cn, travel, o));
        return cost > o.maxDetourMin || base + cost > o.maxRouteMin ? "far" : "early";
      }
      return "full";
    });
    if (verdicts.every((v) => v === "pair")) return "Under 18 and no cleared driver is available.";
    const all = verdicts.filter((v) => v !== "pair");
    if (all.every((v) => v === "toobig")) {
      return `Needs ${need(r)} seats together (${need(r) - 1} coming with them); the biggest car offers ${maxSeats}. ${r.canSplit ? "They said splitting is OK, but there aren't enough seats in total." : "Ask whether it's OK to split them across cars, or arrange a bigger vehicle."}`;
    }
    const rest = all.filter((v) => v !== "toobig");
    if (rest.includes("far")) return "Too far out of the way for the drivers who still have seats.";
    if (rest.includes("early")) return `Would need a pickup before ${o.earliestPickup}.`;
    if (need(r) > 1 && !r.canSplit) return `No single car has ${need(r)} free seats together. Ask whether it's OK to split them across cars.`;
    return `All seats are taken (${riders.reduce((n, x) => n + need(x), 0)} people asking, ${totalSeats} seats offered).`;
  };

  for (const r of still) {
    const want = need(r);
    if (r.canSplit && want > 1) {
      let rem = want;
      for (;;) {
        let got = tryPlace(r, 0, rem, false);
        if (!got) got = tryPlace(r, 1, rem, false);
        if (!got) break;
        rem -= got;
        if (rem <= 0) break;
      }
      if (rem > 0) {
        const reason = rem === want ? diagnose(r) : `Seated ${want - rem} of ${want}; ${rem} still need a seat. All remaining seats are taken.`;
        waitlist.push({ riderId: r.id, seats: rem, reason });
      }
    } else {
      waitlist.push({ riderId: r.id, seats: want, reason: diagnose(r) });
    }
  }

  const assignments = [];
  for (const st of states) {
    st.trips.forEach((t, ti) => t.stops.forEach((s, k) => assignments.push({ riderId: s.id, driverId: st.d.id, trip: ti + 1, order: k, seats: stopSeats(s) })));
  }
  const ev = evaluate({ church, drivers, riders, assignments, travel, date, options });

  return {
    ...ev,
    waitlist,
    excludedDrivers,
    stats: {
      riders: riders.length,
      seated: new Set(assignments.map((a) => a.riderId)).size,
      seatsUsed: assignments.reduce((n, a) => n + a.seats, 0),
      waitlisted: waitlist.length,
      seatsOffered: totalSeats,
      driversUsed: new Set(assignments.map((a) => a.driverId)).size,
      driversAvailable: states.length,
    },
  };
}
