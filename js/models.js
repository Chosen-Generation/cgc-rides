// Shared shapes and rules used by both the demo store and the live store.

// camelCase (used in the app) <-> snake_case (used in the database)
const MAP = {
  name: "full_name", address: "home_address", status: "driver_status",
  userId: "user_id", geoSource: "geo_source", postalCode: "postal_code",
  weeklyCheckin: "weekly_checkin", drivesEveryWeek: "drives_every_week",
  secondTrip: "second_trip", licenceOk: "licence_ok", insuranceOk: "insurance_ok",
  policeCheckExpiry: "police_check_expiry", textsConsentAt: "texts_consent_at",
  textsConsentWithdrawnAt: "texts_consent_withdrawn_at", createdAt: "created_at",
  isSupervisor: "is_supervisor", leaderTitle: "leader_title", isVehicle: "is_vehicle",
};
const SAME = ["id", "email", "phone", "role", "gender", "neighbourhood", "lat", "lng", "minor", "priority", "notes", "seats", "vehicle"];
const toSnake = Object.fromEntries([...Object.entries(MAP), ...SAME.map((k) => [k, k])]);
const toCamel = Object.fromEntries(Object.entries(toSnake).map(([c, s]) => [s, c]));

export function profileFromRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (toCamel[k]) out[toCamel[k]] = v;
  return out;
}

/** Only the keys present are converted, so partial updates stay partial. */
export function profileToRow(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (toSnake[k]) out[toSnake[k]] = v === "" ? null : v;
  return out;
}

/**
 * An explicit choice for that day wins. Otherwise "every week" drivers are counted in for Sundays
 * only: for a special service on another day (e.g. Christmas Eve) they are asked, never assumed.
 */
export function driverAvailable(driver, weeks, day) {
  const w = weeks.find((x) => x.driverId === driver.id && x.sunday === day);
  if (w) return !!w.available;
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d, 12).getDay() === 0 && !!driver.drivesEveryWeek;
}

/** A driver is a driver by role, or a leader who has set themselves up to drive too. */
export const isDriver = (p) => p.role === "driver" || (p.role === "leader" && p.status === "cleared" && p.seats > 0);

export const asDriver = (p, weeks, sunday) => ({ ...p, available: driverAvailable(p, weeks, sunday) });

/** Same rules the database enforces on save_plan, so the demo behaves like the real thing. */
export function validatePlan({ profilesById, sunday, assignments }) {
  const per = new Map();
  for (const a of assignments) {
    const d = profilesById.get(a.driverId);
    if (!d) throw new Error("Unknown driver in plan.");
    if (d.status !== "cleared") throw new Error("Only cleared drivers can be given riders.");
    const key = `${a.driverId}|${a.trip || 1}`;
    per.set(key, (per.get(key) || 0) + (a.seats ?? 1));
  }
  for (const [key, n] of per) {
    const d = profilesById.get(key.split("|")[0]);
    if (n > (d.seats || 0)) throw new Error("A car has more people than seats (counting everyone coming with each rider).");
  }
}

export const DRIVER_STATUS_TEXT = {
  none: "Not a driver",
  pending: "Waiting for the transport leader to approve you as a driver",
  cleared: "Cleared to drive",
  suspended: "Paused by the leader",
};

export const CONSENT_WORDING =
  "I agree that Chosen Generation Church may text me about rides (pickup times, changes and reminders). I can say STOP or tell the transport leader at any time to withdraw this.";

/** Days until a YYYY-MM-DD date, from a given "today". */
export function daysLeft(iso, todayISO) {
  if (!iso) return null;
  return Math.round((Date.parse(iso) - Date.parse(todayISO)) / 86400000);
}
