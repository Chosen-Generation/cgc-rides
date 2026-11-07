// The church van. In the data it is a "vehicle" profile (isVehicle): always cleared, parked at the
// church, up to 14 passengers, allowed a second trip. For each service day a leader chooses who
// drives it (data.vanShifts); that person's own car isn't used that day. After the service the van
// can take people home: riders who asked for a ride home, in a sensible drop-off order.

import { toMin } from "./dates.js";

export const VAN_MAX_SEATS = 14;
/** By default the van leaves church to take people home this long after the service starts. */
export const HOME_AFTER_START_MIN = 135;

export const findVan = (profiles) => (profiles || []).find((p) => p.isVehicle) || null;
export const vanShiftFor = (data, day) => (data?.vanShifts || []).find((s) => s.sunday === day) || null;
export function vanDriverFor(data, day) {
  const s = vanShiftFor(data, day);
  return s?.driverId ? (data.profiles || []).find((p) => p.id === s.driverId) || null : null;
}
/** "Dami Elufisan (church van)" or "Church van (no driver yet)". */
export function vanName(data, day) {
  const d = vanDriverFor(data, day);
  return d ? `${d.name} (church van)` : "Church van (no driver yet)";
}
/** When the van leaves church to take people home, in minutes after midnight. */
export function homeDepartFor(data, day, serviceTime) {
  const s = vanShiftFor(data, day);
  return s?.homeDepartMin ?? toMin(serviceTime) + HOME_AFTER_START_MIN;
}

/**
 * Profiles as they should read on one service day: the van shows who drives it and their phone.
 * Everything else is unchanged.
 */
export function profilesForDay(data, day) {
  const d = vanDriverFor(data, day);
  return (data.profiles || []).map((p) => (p.isVehicle
    ? { ...p, name: vanName(data, day), phone: d?.phone || null, vehicle: "Church van", vanDriverId: d?.id || null }
    : p));
}

/**
 * The drivers the planner may use on a day, with the van in place: the van drives only if a
 * cleared driver was chosen for it, and that driver's own car stays home.
 */
export function withVan(drivers, data, day) {
  const van = drivers.find((d) => d.isVehicle);
  if (!van) return drivers;
  const vd = vanDriverFor(data, day);
  const ok = !!vd && vd.status === "cleared";
  return drivers.map((d) => {
    if (d.isVehicle) return { ...d, name: vanName(data, day), phone: vd?.phone || null, available: ok, vanDriverId: ok ? vd.id : null, noVanDriver: !ok };
    if (ok && d.id === vd.id) return { ...d, available: false, drivingVan: true };
    return d;
  });
}

/**
 * Rides home in the van after the service.
 * riders: everyone asking that day (with rideHome, lat/lng, extraPeople). van: the van (or null).
 * Returns { departMin, stops: [{ riderId, order, dropMin, seats }], overflow: [{ riderId, seats, reason }] },
 * or null when there's no van or nobody asked for a ride home.
 */
export function planHome({ church, van, riders, travel, departMin, stopMin = 3 }) {
  const want = (riders || []).filter((r) => r.rideHome);
  if (!van || !want.length) return null;
  const seatsOf = (r) => 1 + Math.max(0, Number(r.extraPeople) || 0);
  const overflow = [];
  if (!van.vanDriverId) {
    for (const r of want) overflow.push({ riderId: r.id, seats: seatsOf(r), reason: "No van driver chosen for this day yet." });
    return { departMin, stops: [], overflow };
  }
  const cn = { id: "church", lat: church.lat, lng: church.lng };
  const node = (r) => ({ id: `R:${r.id}`, lat: r.lat, lng: r.lng });
  let todo = [];
  for (const r of want) {
    if (r.lat == null || r.lng == null) overflow.push({ riderId: r.id, seats: seatsOf(r), reason: "Home address not confirmed, so the van can't plan a drop-off." });
    else todo.push(r);
  }
  // Farthest first decides who fits if there are too many; then drop off nearest-next from church.
  todo.sort((a, b) => travel(cn, node(a)) - travel(cn, node(b)));
  let free = van.seats || 0;
  const going = [];
  for (const r of todo) {
    if (seatsOf(r) <= free) { going.push(r); free -= seatsOf(r); }
    else overflow.push({ riderId: r.id, seats: seatsOf(r), reason: "The van is full. Arrange another ride home." });
  }
  const stops = [];
  let at = cn, t = departMin, left = [...going];
  while (left.length) {
    left.sort((a, b) => travel(at, node(a)) - travel(at, node(b)));
    const r = left.shift();
    t += travel(at, node(r));
    stops.push({ riderId: r.id, order: stops.length, dropMin: Math.round(t / 5) * 5, seats: seatsOf(r) });
    t += stopMin;
    at = node(r);
  }
  return { departMin, stops, overflow };
}
