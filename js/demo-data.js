// Sample people for DEMO mode. Everyone here is fictional.
// Addresses are placeholders and locations are near neighbourhood centres (marked as confirmed
// so the demo can be planned). The demo shows how matching behaves, not where real people live.

import { neighbourhoodCentre } from "./geo.js";
import { nextSundays, toISO } from "./dates.js";

// Placeholder only, near downtown. The real church location goes in js/config.js.
export const DEMO_CHURCH = { lat: 52.1332, lng: -106.67, label: "Demo church (placeholder location, not the real one)" };

function jitter(i, axis) {
  const x = Math.sin(i * 12.9898 + axis * 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.008; // up to about 400 m
}

export function makeDemoState(now = new Date()) {
  const sundays = nextSundays(4, now);
  const inDays = (n) => toISO(new Date(now.getTime() + n * 86400000));
  let n = 0;
  const base = (id, name, hood, extra) => {
    n += 1;
    const c = neighbourhoodCentre(hood);
    return {
      id, userId: id, email: `${id}@demo.invalid`, name, phone: `306-555-01${String(n).padStart(2, "0")}`,
      role: "rider", gender: null, address: `Sample address, ${hood}`, neighbourhood: hood,
      lat: c ? c.lat + jitter(n, 1) : null, lng: c ? c.lng + jitter(n, 2) : null, geoSource: c ? "verified" : "none", postalCode: null,
      minor: false, priority: false,
      weeklyCheckin: false, notes: null, seats: 0, drivesEveryWeek: false, secondTrip: false, vehicle: null,
      status: "none", licenceOk: false, insuranceOk: false, policeCheckExpiry: null,
      textsConsentAt: null, textsConsentWithdrawnAt: null, ...extra,
    };
  };
  const driver = (id, name, hood, extra) =>
    base(id, name, hood, { role: "driver", status: "cleared", licenceOk: true, insuranceOk: true, policeCheckExpiry: inDays(300), ...extra });

  const profiles = [
    base("leader", "Transport Leader (demo)", "Nutana", { role: "leader", isSupervisor: true, leaderTitle: "Supervisor", phone: "306-555-0100", gender: "F" }),
    driver("d-grace", "Grace Adeyemi", "Stonebridge", { gender: "F", seats: 4, drivesEveryWeek: true, vehicle: "Silver minivan", textsConsentAt: now.toISOString() }),
    driver("d-daniel", "Daniel Okafor", "Evergreen", { gender: "M", seats: 3, drivesEveryWeek: true, vehicle: "Grey SUV" }),
    driver("d-ruth", "Ruth Mensah", "Confederation Park", { gender: "F", seats: 3, secondTrip: true, vehicle: "Blue sedan" }),
    driver("d-samuel", "Samuel Boateng", "Lawson Heights", { gender: "M", seats: 2, drivesEveryWeek: true, vehicle: "Red hatchback", policeCheckExpiry: inDays(12) }),
    driver("d-esther", "Esther Williams", "Nutana", { gender: "F", seats: 3, vehicle: "White van", status: "suspended" }), // paused by the leader: gets no riders
    base("d-new", "Joel Anderson", "Briarwood", { role: "driver", status: "pending", gender: "M", seats: 4, vehicle: "Black truck (crew cab)" }),
    base("r-mary", "Mary Johnson", "Evergreen", { gender: "F", priority: true, weeklyCheckin: true, notes: "Uses a walker (folds into the trunk)", textsConsentAt: now.toISOString() }),
    base("r-peter", "Peter Nkosi", "Brighton", { gender: "M", weeklyCheckin: true }),
    base("r-amara", "Amara Eze", "Stonebridge", { gender: "F" }),
    base("r-tobi", "Tobi Adebayo", "Riversdale", { gender: "M", minor: true }),
    base("r-lydia", "Lydia Chen", "Lakeview", { gender: "F", weeklyCheckin: true }),
    base("r-david", "David Osei", "Silverspring", { gender: "M" }),
    base("r-faith", "Faith Mwangi", "Willowgrove", { gender: "F" }),
    base("r-joy", "Joy Banda", "Hampton Village", { gender: "F" }),
    base("r-kofi", "Kofi Asante", "Westmount", { gender: "M" }),
    base("r-naomi", "Naomi Clarke", "Varsity View", { gender: "F" }),
    base("r-isaac", "Isaac Moyo", "Avalon", { gender: "M", notes: "No saved map location; leader must set one" }),
  ];

  const mk = (riderId, sunday, rideHome = false, note = null) => ({ id: `q-${riderId}-${sunday}`, riderId, sunday, rideHome, note, status: "requested" });
  const first = sundays[0];
  const requests = [
    ...["r-mary", "r-peter", "r-amara", "r-tobi", "r-lydia", "r-david", "r-faith", "r-joy", "r-kofi", "r-isaac"].map((id) => mk(id, first)),
  ];
  requests[0].rideHome = true;
  requests.find((r) => r.riderId === "r-faith").extraPeople = 2; // Faith is bringing two children

  // Ruth (second trip) is free the first Sunday; Daniel is away the second.
  const weeks = [
    { driverId: "d-ruth", sunday: first, available: true },
    { driverId: "d-daniel", sunday: sundays[1], available: false, note: "Away" },
  ];
  return { sundays, profiles, requests, weeks, plans: {}, alerts: [], consentLog: [], help: [], services: [], teamLog: [], pushLog: [],
    signupIssues: [{ at: inDays(-1), email: "vanessa.example@demo.invalid", category: "Home address", message: "We couldn't find that exact house.", role: "rider" }],
    unregistered: [{ email: "vanessa.example@demo.invalid", signedUpAt: inDays(-1), lastSignInAt: inDays(-1) }, { email: "tobi.example@demo.invalid", signedUpAt: inDays(-1), lastSignInAt: null }] };
}
