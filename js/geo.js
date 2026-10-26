// Geography helpers: neighbourhood names, straight-line estimates, address lookup.
//
// HONESTY NOTE: the neighbourhood coordinates below are approximate centres written by
// hand (good to roughly 1-2 km). They are only a fallback for when an address can't be
// looked up, and the leader sees a "location approximate" badge whenever one is used.
// Names with null coordinates have no fallback at all.

export const NEIGHBOURHOODS = [
  ["Downtown", 52.1332, -106.67], ["Nutana", 52.1215, -106.6519], ["City Park", 52.1349, -106.6602],
  ["Varsity View", 52.1197, -106.6407], ["Lakeview", 52.0989, -106.628], ["Lawson Heights", 52.1622, -106.6689],
  ["Silverspring", 52.1697, -106.6494], ["Stonebridge", 52.0872, -106.6244], ["Briarwood", 52.0925, -106.6323],
  ["Wildwood", 52.105, -106.612], ["Riversdale", 52.1257, -106.6768], ["Confederation Park", 52.1264, -106.7231],
  ["Westmount", 52.1367, -106.6844], ["Mount Royal", 52.142, -106.698], ["Meadowgreen", 52.15, -106.71],
  ["Pleasant Hill", 52.118, -106.685], ["King George", 52.115, -106.678], ["Erindale", 52.0975, -106.6975],
  ["Blairmore", 52.145, -106.735], ["Kensington", 52.085, -106.715], ["Evergreen", 52.1755, -106.596],
  ["Brighton", 52.08, -106.557], ["Rosewood", 52.094, -106.59], ["Willowgrove", 52.1085, -106.5395],
  ["Hampton Village", 52.115, -106.528], ["Aspen Ridge", 52.118, -106.533], ["Arbor Creek", 52.156, -106.623],
  ["Silverwood Heights", 52.158, -106.605], ["Sutherland", 52.148, -106.583], ["North Park", 52.156, -106.695],
  // Real neighbourhoods with no fallback coordinates (an address lookup is needed for these):
  ["Avalon", null, null], ["Buena Vista", null, null], ["Caswell Hill", null, null],
  ["Greystone Heights", null, null], ["Holiday Park", null, null], ["Massey Place", null, null],
  ["Montgomery Place", null, null], ["Adelaide/Churchill", null, null], ["Fairhaven", null, null],
  ["Hudson Bay Park", null, null], ["Dundonald", null, null], ["Exhibition", null, null],
  ["Forest Grove", null, null], ["Eastview", null, null], ["Nutana Park", null, null],
  ["Lakeridge", null, null], ["Parkridge", null, null], ["Other / not listed", null, null],
].map(([name, lat, lng]) => ({ name, lat, lng }));

export const neighbourhoodCentre = (name) => {
  const n = NEIGHBOURHOODS.find((x) => x.name === name);
  return n && n.lat != null ? { lat: n.lat, lng: n.lng } : null;
};

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Fallback drive-time guess in minutes: straight line x 1.35 for streets at ~32 km/h.
 * It does NOT know about the river or bridges. Real road times come from routing.js
 * when the free routing service is reachable.
 */
export function estimateMinutes(a, b) {
  return ((haversineKm(a, b) * 1.35) / 32) * 60;
}

/**
 * Look up an address with OpenStreetMap's free Nominatim service (browser only).
 * Falls back to the neighbourhood's approximate centre, then to nothing.
 * Returns { lat, lng, source: "address" | "neighbourhood" | "none" }.
 */
export async function geocode(address, { neighbourhood, nominatimUrl, enabled = true, fetchFn } = {}) {
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  if (enabled && doFetch && address && address.trim()) {
    try {
      const url = new URL("/search", nominatimUrl || "https://nominatim.openstreetmap.org");
      url.searchParams.set("q", `${address.trim()}, Saskatoon, Saskatchewan, Canada`);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", "ca");
      url.searchParams.set("viewbox", "-106.85,52.25,-106.45,52.0"); // Saskatoon area
      url.searchParams.set("bounded", "1");
      const res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
      if (res.ok) {
        const hits = await res.json();
        if (Array.isArray(hits) && hits.length) {
          return { lat: Number(hits[0].lat), lng: Number(hits[0].lon), source: "address" };
        }
      }
    } catch (_) {
      /* fall through to the neighbourhood fallback */
    }
  }
  const centre = neighbourhoodCentre(neighbourhood);
  return centre ? { ...centre, source: "neighbourhood" } : { lat: null, lng: null, source: "none" };
}

// ---------------------------------------------------------------- confirmed addresses
//
// A rider or driver is only matched once their home address is CONFIRMED: found on the map
// down to the exact house number, inside the Saskatoon area. Confirmed locations are saved
// with geo_source = "verified". Anything less (a street with no house, a neighbourhood
// centre, an old unchecked lookup) is never used for matching or timing.
//
// Suggestions while typing come from Photon (komoot), which is built for search-as-you-type.
// The final check uses Nominatim (OpenStreetMap), at most once per save, as its rules allow.
// Both are free, need no key, and are called from the person's browser.
//
// UNTESTED against the real services from the build environment (no network there).
// The parsing below follows their documented formats and is tested with sample answers.

/** Saskatoon area: [west, south, east, north]. */
export const AREA = { west: -106.85, south: 52.0, east: -106.45, north: 52.25 };
const inArea = (lat, lng) => lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;

/** geo_source values that may be used for matching and timing. */
// For homes the map service doesn't list by house number yet, the person marks the spot themselves:
// "gps" = with their phone's location while at home; "pin" = by dragging a pin onto the house.
export const CONFIRMED_SOURCES = new Set(["verified", "manual", "gps", "pin"]);
export const inSaskatoon = (lat, lng) => lat != null && lng != null && inArea(Number(lat), Number(lng));
export const isConfirmed = (p) => !!p && p.lat != null && p.lng != null && CONFIRMED_SOURCES.has(p.geoSource);

/** "3065550142", "(306) 555-0142", "+1 306 555 0142" -> "306-555-0142". Anything else -> null. */
export function normalizePhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d) || /^[01]/.test(d.slice(3))) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** "s7n0a1" -> "S7N 0A1". Letters D, F, I, O, Q, U never appear; W and Z never come first. */
export function normalizePostal(input) {
  const s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(s)) return null;
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Saskatoon postal codes start with S7. Rural addresses nearby use S0K and similar. */
export const isSaskatoonPostal = (pc) => /^S7/.test(pc || "");

/** House number from "1666 Stonebridge Blvd" or "12-345 Main St" (unit 12, house 345). */
export const houseNumberOf = (text) => (String(text || "").match(/^\s*(?:\w+\s*-\s*(?=\d))?(\d+[A-Za-z]?)\b/) || [])[1] || null;
const sameHouse = (a, b) => !!a && !!b && String(a).toUpperCase().replace(/\s/g, "") === String(b).toUpperCase().replace(/\s/g, "");

/** Nearest named neighbourhood centre within 2.5 km (only used when the map service names none). */
export function nearestNeighbourhood(lat, lng) {
  let best = null;
  for (const n of NEIGHBOURHOODS) {
    if (n.lat == null) continue;
    const km = haversineKm({ lat, lng }, n);
    if (km <= 2.5 && (!best || km < best.km)) best = { name: n.name, km };
  }
  return best ? best.name : null;
}

const fullLabel = (house, street, unit) => `${unit ? unit + "-" : ""}${house} ${street}`.trim();

/**
 * Suggestions while typing. Returns up to 6 exact house addresses in the Saskatoon area:
 * [{ label, address, postcode, neighbourhood, lat, lng }]. Never throws; [] on any problem.
 */
export async function suggestAddresses(query, { photonUrl = "https://photon.komoot.io", fetchFn, signal } = {}) {
  const q = String(query || "").trim();
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!doFetch || q.length < 4 || !/\d/.test(q)) return [];
  try {
    const url = new URL("/api/", photonUrl);
    url.searchParams.set("q", /saskatoon/i.test(q) ? q : `${q}, Saskatoon`);
    url.searchParams.set("limit", "10");
    url.searchParams.set("lang", "en");
    url.searchParams.set("lat", "52.13");
    url.searchParams.set("lon", "-106.66");
    url.searchParams.set("bbox", `${AREA.west},${AREA.south},${AREA.east},${AREA.north}`);
    const res = await doFetch(url.toString(), { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    const seen = new Set();
    for (const f of data.features || []) {
      const p = f.properties || {};
      const [lng, lat] = (f.geometry && f.geometry.coordinates) || [];
      if (!p.housenumber || !p.street || lat == null || !inArea(lat, lng)) continue;
      if (p.countrycode && p.countrycode.toUpperCase() !== "CA") continue;
      const address = fullLabel(p.housenumber, p.street);
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const postcode = normalizePostal(p.postcode);
      const neighbourhood = p.district || p.locality || nearestNeighbourhood(lat, lng);
      out.push({ address, label: [address, neighbourhood, postcode].filter(Boolean).join(" · "), postcode, neighbourhood, lat, lng });
      if (out.length >= 6) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Final check of an address someone typed (or picked). Confirmed only if the map service finds
 * that exact house number on that street inside the Saskatoon area.
 * Returns { ok: true, address, postcode, neighbourhood, lat, lng }
 *      or { ok: false, reason } with a reason a person can act on.
 */
export async function confirmAddress(address, { nominatimUrl = "https://nominatim.openstreetmap.org", fetchFn, postcode } = {}) {
  const text = String(address || "").trim();
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  const house = houseNumberOf(text);
  if (!text) return { ok: false, reason: "Please enter your home address." };
  if (!house) return { ok: false, reason: "Start the address with the house number, for example 1666 Stonebridge Blvd." };
  if (!doFetch) return { ok: false, reason: "The address check isn't available right now. Please try again." };
  try {
    const url = new URL("/search", nominatimUrl);
    url.searchParams.set("q", /saskatoon/i.test(text) ? `${text}, Saskatchewan, Canada` : `${text}, Saskatoon, Saskatchewan, Canada`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "ca");
    url.searchParams.set("viewbox", `${AREA.west},${AREA.north},${AREA.east},${AREA.south}`);
    url.searchParams.set("bounded", "1");
    const res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: "The address check isn't available right now. Please try again in a minute." };
    const hits = await res.json();
    if (!Array.isArray(hits) || !hits.length) return { ok: false, reason: "We couldn't find that address in Saskatoon. Check the house number and street name (for example 1666 Stonebridge Blvd), or pick one of the suggestions." };
    const exact = hits.find((h) => h.address && sameHouse(h.address.house_number, house) && inArea(Number(h.lat), Number(h.lon)));
    if (!exact) {
      const street = hits[0].address?.road;
      return { ok: false, reason: street
        ? `We found ${street}, but not house number ${house} on it. Check the number, or pick one of the suggestions.`
        : "We couldn't find that exact house. Check the house number and street name, or pick one of the suggestions." };
    }
    const a = exact.address;
    const lat = Number(exact.lat), lng = Number(exact.lon);
    return {
      ok: true,
      address: fullLabel(a.house_number, a.road || text.replace(/^\S+\s*/, "")),
      postcode: normalizePostal(a.postcode) || normalizePostal(postcode),
      neighbourhood: a.neighbourhood || a.suburb || a.quarter || a.city_district || nearestNeighbourhood(lat, lng),
      lat, lng,
    };
  } catch (_) {
    return { ok: false, reason: "The address check isn't available right now. Please try again in a minute." };
  }
}

/**
 * What's at a point (for a pin or the phone's location): the nearest address the map knows,
 * its postal code and neighbourhood. Never throws; fields are null when unknown.
 */
export async function reverseLookup(lat, lng, { nominatimUrl = "https://nominatim.openstreetmap.org", fetchFn } = {}) {
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  const out = { address: null, street: null, postcode: null, neighbourhood: inArea(lat, lng) ? nearestNeighbourhood(lat, lng) : null };
  if (!doFetch) return out;
  try {
    const url = new URL("/reverse", nominatimUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");
    const res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return out;
    const a = (await res.json()).address || {};
    out.street = a.road || null;
    out.address = a.road ? (a.house_number ? fullLabel(a.house_number, a.road) : a.road) : null;
    out.postcode = normalizePostal(a.postcode);
    out.neighbourhood = a.neighbourhood || a.suburb || a.quarter || a.city_district || out.neighbourhood;
    return out;
  } catch (_) {
    return out;
  }
}

/** Roughly where a typed street is, to start the map there. { lat, lng } or null. Never throws. */
export async function locateStreet(text, { photonUrl = "https://photon.komoot.io", fetchFn } = {}) {
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  const q = String(text || "").trim();
  if (!doFetch || q.length < 3) return null;
  try {
    const url = new URL("/api/", photonUrl);
    url.searchParams.set("q", /saskatoon/i.test(q) ? q : `${q}, Saskatoon`);
    url.searchParams.set("limit", "5");
    url.searchParams.set("lat", "52.13");
    url.searchParams.set("lon", "-106.66");
    url.searchParams.set("bbox", `${AREA.west},${AREA.south},${AREA.east},${AREA.north}`);
    const res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    for (const f of (await res.json()).features || []) {
      const [lng, lat] = f.geometry?.coordinates || [];
      if (lat != null && inArea(lat, lng)) return { lat, lng };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Street-type words in their short form, so "Blvd" matches "Boulevard" and so on.
const SHORT = { boulevard: "blvd", street: "st", avenue: "ave", drive: "dr", crescent: "cres", road: "rd", court: "crt",
  place: "pl", lane: "ln", terrace: "terr", way: "way", circle: "cir", bay: "bay", manor: "mnr", trail: "trl",
  east: "e", west: "w", north: "n", south: "s", saskatoon: "" };
const words = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => SHORT[w] ?? w).filter(Boolean);

/**
 * Narrows suggestions already on screen as the person keeps typing, with no network call:
 * every typed word must start a word of the address ("1666 stoneb" keeps "1666 Stonebridge Blvd").
 */
export function refineSuggestions(list, query) {
  const q = words(query);
  if (!q.length) return [];
  return (list || []).filter((s) => {
    const raw = String(s.address || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const a = [...new Set([...words(s.address), ...raw])];
    return q.every((w, i) => (i === 0 && /^\d/.test(w) ? a[0] === w || (q.length === 1 && a[0].startsWith(w)) : a.some((x) => x.startsWith(w) || w.startsWith(x) && x.length > 2)));
  });
}
