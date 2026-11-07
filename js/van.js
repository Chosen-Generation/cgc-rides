// The church van. In the data it is a "vehicle" profile (isVehicle): always cleared, up to 14
// passengers, allowed a second trip, normally parked at the church. It's used only on days a
// leader chooses who drives it (data.vanShifts); that person's own car isn't used that day.
// The van driver starts from the church, or from their home if they took the van home.

import { isConfirmed } from "./geo.js";

export const VAN_MAX_SEATS = 14;

export const findVan = (profiles) => (profiles || []).find((p) => p.isVehicle) || null;
export const vanShiftFor = (data, day) => (data?.vanShifts || []).find((s) => s.sunday === day && s.driverId) || null;
export function vanDriverFor(data, day) {
  const s = vanShiftFor(data, day);
  return s ? (data.profiles || []).find((p) => p.id === s.driverId) || null : null;
}
/** "Dami Elufisan (church van)" or "Church van (no driver)". */
export function vanName(data, day) {
  const d = vanDriverFor(data, day);
  return d ? `${d.name} (church van)` : "Church van (no driver)";
}
/** Where the van starts that day: "home" only if the driver's home is confirmed on the map. */
export function vanStartFor(data, day) {
  const s = vanShiftFor(data, day);
  const d = vanDriverFor(data, day);
  return s?.startFrom === "home" && d && isConfirmed(d) ? "home" : "church";
}

/** Profiles as they should read on one service day: the van shows who drives it and their phone. */
export function profilesForDay(data, day) {
  const d = vanDriverFor(data, day);
  return (data.profiles || []).map((p) => (p.isVehicle
    ? { ...p, name: vanName(data, day), phone: d?.phone || null, vehicle: "Church van", vanDriverId: d?.id || null, vanStart: vanStartFor(data, day) }
    : p));
}

/**
 * The drivers the planner may use on a day, with the van in place: the van drives only if a
 * cleared driver was chosen for it, starting from the church or from that driver's home, and the
 * driver's own car stays home.
 */
export function withVan(drivers, data, day) {
  const van = drivers.find((d) => d.isVehicle);
  if (!van) return drivers;
  const vd = vanDriverFor(data, day);
  const ok = !!vd && vd.status === "cleared";
  const fromHome = ok && vanStartFor(data, day) === "home";
  return drivers.map((d) => {
    if (d.isVehicle) {
      return { ...d, name: vanName(data, day), phone: vd?.phone || null, available: ok, vanDriverId: ok ? vd.id : null, noVanDriver: !ok,
        vanStart: fromHome ? "home" : "church", ...(fromHome ? { lat: vd.lat, lng: vd.lng } : {}) };
    }
    if (ok && d.id === vd.id) return { ...d, available: false, drivingVan: true };
    return d;
  });
}

// ---------------------------------------------------------------- logbook
// The van driver checks the van before driving and logs it after parking.
export const VAN_CHECKS = [
  ["walkaround", "I walked all around the van"],
  ["tires", "Tires look properly inflated"],
  ["lights", "Headlights, brake lights and turn signals work"],
  ["mirrors", "Seat and mirrors adjusted for me"],
  ["belts", "Every seatbelt clicks and releases"],
  ["clean", "Inside is clean, nothing left behind"],
];
export const FUEL_LEVELS = [["full", "Full"], ["3/4", "3/4"], ["1/2", "1/2"], ["1/4", "1/4"], ["low", "Low (under 1/4)"]];
