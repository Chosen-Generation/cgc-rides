// LIVE store: talks to your Supabase project. Same methods as the demo store.
// The database (supabase/schema.sql) decides who may see what; this file never relies on
// hiding things in the screens.
//
// Untested against a real Supabase project from the build environment (no network there).
// The SQL it calls is tested separately; see tests/sql.test.mjs and the README test plan.

import { profileFromRow, profileToRow } from "./models.js";
import { nextSundays } from "./dates.js";
import { geocode } from "./geo.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const camelRow = (r, map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, r[v]]));
const fail = ({ error }) => { if (error) throw new Error(error.message || String(error)); };

export async function createLiveStore(config, { createClient } = {}) {
  const make = createClient || (await import(SUPABASE_JS)).createClient;
  const sb = make(config.supabase.url, config.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let user = null;
  let cachedMe;

  const rpc = async (fn, args) => { const res = await sb.rpc(fn, args); fail(res); return res.data; };
  const from = (t) => sb.from(t);
  const getUid = () => { if (!user) throw new Error("Please sign in."); return user.id; };

  const requestFrom = (r) => ({ id: r.id, riderId: r.rider_id, sunday: r.sunday, rideHome: r.ride_home, note: r.note, extraPeople: r.extra_people || 0, canSplit: !!r.can_split, status: r.status });
  const rideFrom = (r) => camelRow(r, { sunday: "sunday", status: "status", rideHome: "ride_home", note: "note", extraPeople: "extra_people", canSplit: "can_split", driverName: "driver_name", driverPhone: "driver_phone", vehicle: "vehicle", seats: "seats", trip: "trip", pickupMin: "pickup_min", readyByMin: "ready_by_min", arriveMin: "arrive_min", waitlistedSeats: "waitlisted_seats" });
  const routeFrom = (r) => camelRow(r, { trip: "trip", order: "stop_order", pickupMin: "pickup_min", readyByMin: "ready_by_min", arriveMin: "arrive_min", departMin: "depart_min", riderName: "rider_name", riderPhone: "rider_phone", address: "address", neighbourhood: "neighbourhood", lat: "lat", lng: "lng", minor: "minor", riderNotes: "rider_notes", requestNote: "request_note", rideHome: "ride_home", extraPeople: "extra_people", seats: "seats", partyTotal: "party_total" });

  return {
    mode: "live",

    /** Restores a saved sign-in (also handles the return from the emailed link). */
    async init(onChange) {
      const { data } = await sb.auth.getSession();
      user = data.session?.user ?? null;
      sb.auth.onAuthStateChange((_event, session) => {
        user = session?.user ?? null;
        cachedMe = undefined;
        if (onChange) onChange();
      });
      return user;
    },
    session() { return user ? { userId: user.id, email: user.email } : null; },
    async signIn(email) {
      const res = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: typeof location !== "undefined" ? location.href.split("#")[0].split("?")[0] : undefined } });
      if (res.error && /rate limit|too many|seconds/i.test(res.error.message || "")) throw new Error("Too many sign-in emails were requested just now. Wait a few minutes and try again, and check your inbox and spam for the last link we sent. (Technical detail: " + res.error.message + ")");
      fail(res);
    },
    /** Signs in with the 6-digit code from the email (an alternative to tapping the link). */
    async verifyCode(email, code) {
      const res = await sb.auth.verifyOtp({ email, token: String(code).replace(/\s+/g, ""), type: "email" });
      if (res.error) throw new Error(/expired|invalid/i.test(res.error.message || "") ? "That code didn't work. It may have expired or been typed wrong. Check the newest email, or go back and ask for a new one." : res.error.message);
      user = res.data?.user ?? res.data?.session?.user ?? user;
      cachedMe = undefined;
    },
    async signOut() { await sb.auth.signOut(); user = null; cachedMe = undefined; },
    sundays() { return nextSundays(config.weeksAhead); },

    /** fresh = re-read from the database (each refresh does, so a role change shows within 30 seconds). */
    async getMe({ fresh = false } = {}) {
      if (!user) return null;
      if (cachedMe !== undefined && !fresh) return cachedMe;
      const res = await from("profiles").select("*").eq("user_id", user.id).maybeSingle();
      fail(res);
      cachedMe = profileFromRow(res.data);
      return cachedMe;
    },
    async saveMyProfile(patch) {
      const uid = getUid();
      const existing = await this.getMe();
      const row = profileToRow(patch);
      delete row.id; delete row.user_id; delete row.email;
      if (existing?.role !== "leader") delete row.driver_status;
      let res;
      if (existing) res = await from("profiles").update(row).eq("user_id", uid).select().single();
      else res = await from("profiles").insert({ ...row, user_id: uid, email: user.email }).select().single();
      fail(res);
      cachedMe = profileFromRow(res.data);
      return cachedMe;
    },

    // ---- rider
    async myRides() { return (await rpc("my_rides")).map(rideFrom); },
    async requestRide(sunday, { rideHome = false, note = null, extraPeople = 0, canSplit = false } = {}) {
      const me = await this.getMe();
      fail(await from("ride_requests").upsert({ rider_id: me.id, sunday, ride_home: rideHome, note, extra_people: extraPeople, can_split: canSplit, status: "requested" }, { onConflict: "rider_id,sunday" }));
    },
    async cancelRide(sunday) {
      const me = await this.getMe();
      fail(await from("ride_requests").update({ status: "cancelled" }).eq("rider_id", me.id).eq("sunday", sunday));
    },
    async giveConsent(wording, profileId = null) { await rpc("give_text_consent", { p_wording: wording, p_profile: profileId }); cachedMe = undefined; },
    async withdrawConsent(profileId = null) { await rpc("withdraw_text_consent", { p_profile: profileId }); cachedMe = undefined; },

    // ---- driver
    async myWeeks() {
      const me = await this.getMe();
      const res = await from("driver_weeks").select("*").eq("driver_id", me.id);
      fail(res);
      return res.data.map((w) => ({ driverId: w.driver_id, sunday: w.sunday, available: w.available, note: w.note }));
    },
    async setAvailability(sunday, available, note = null) {
      const me = await this.getMe();
      fail(await from("driver_weeks").upsert({ driver_id: me.id, sunday, available, note }, { onConflict: "driver_id,sunday" }));
    },
    async myRoute(sunday) { return (await rpc("my_route", { p_sunday: sunday })).map(routeFrom); },
    async cantMakeIt(sunday, note = null) { return rpc("driver_cant_make_it", { p_sunday: sunday, p_note: note }); },

    // ---- leader
    /** Every row of every table, for the leader's backup. Pages through results (1000 per request). */
    async exportAll() {
      const out = {};
      for (const t of ["profiles", "consent_log", "driver_weeks", "ride_requests", "plans", "assignments", "waitlist", "alerts"]) {
        const rows = [];
        for (let from = 0; ; from += 1000) {
          const res = await sb.from(t).select("*").range(from, from + 999);
          fail(res);
          rows.push(...res.data);
          if (res.data.length < 1000) break;
        }
        out[t] = rows;
      }
      return out;
    },
    async leaderData() {
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const [pr, rq, wk, pl, as, wl, al, cl, hr, ha, tl] = await Promise.all([
        from("profiles").select("*").order("full_name"),
        from("ride_requests").select("*").gte("sunday", since),
        from("driver_weeks").select("*").gte("sunday", since),
        from("plans").select("*").gte("sunday", since),
        from("assignments").select("*"),
        from("waitlist").select("*"),
        // Every open alert, plus done ones from the last 14 days (older ones stay in the database).
        from("alerts").select("*").or(`resolved.eq.false,created_at.gte.${new Date(Date.now() - 14 * 86400000).toISOString()}`).order("created_at", { ascending: false }).limit(300),
        from("consent_log").select("*").order("at", { ascending: false }).limit(200),
        from("help_requests").select("*").gte("sunday", since).neq("status", "cancelled").order("created_at", { ascending: false }),
        from("help_asks").select("*"),
        from("team_log").select("*").order("at", { ascending: false }).limit(50),
      ]);
      // These need the 21 Oct database update; until then, empty.
      const [ur, pp] = await Promise.all([sb.rpc("unregistered_people"), sb.rpc("push_people")]);
      for (const r of [pr, rq, wk, pl, as, wl, al, cl]) fail(r);
      // Last-minute requests need the 20 Oct (afternoon) database update; until then, there are none.
      const helpRequests = hr.error || ha.error ? [] : hr.data.map((h) => ({
        id: h.id, sunday: h.sunday, riderName: h.rider_name, riderPhone: h.rider_phone, address: h.address, neighbourhood: h.neighbourhood,
        postalCode: h.postal_code, lat: h.lat, lng: h.lng, seats: h.seats, pickupMin: h.pickup_min, status: h.status,
        acceptedBy: h.accepted_by, acceptedAt: h.accepted_at, createdAt: h.created_at,
        asks: ha.data.filter((k) => k.request_id === h.id).map((k) => ({ driverId: k.driver_id, awayMin: k.away_min, answer: k.answer })),
      }));
      const plans = {};
      for (const p of pl.data) {
        plans[p.sunday] = {
          sunday: p.sunday, status: p.status, summary: p.summary, approvedAt: p.approved_at,
          assignments: as.data.filter((a) => a.plan_id === p.id).map((a) => ({ riderId: a.rider_id, driverId: a.driver_id, trip: a.trip, order: a.stop_order, seats: a.seats, pickupMin: a.pickup_min, readyByMin: a.ready_by_min, arriveMin: a.arrive_min, departMin: a.depart_min })),
          waitlist: wl.data.filter((w) => w.plan_id === p.id).map((w) => ({ riderId: w.rider_id, reason: w.reason, seats: w.seats })),
        };
      }
      return {
        profiles: pr.data.map(profileFromRow),
        requests: rq.data.map(requestFrom),
        weeks: wk.data.map((w) => ({ driverId: w.driver_id, sunday: w.sunday, available: w.available, note: w.note })),
        plans,
        alerts: al.data.map((a) => ({ id: a.id, kind: a.kind, sunday: a.sunday, driverId: a.driver_id, riderId: a.rider_id, message: a.message, resolved: a.resolved, createdAt: a.created_at })),
        consentLog: cl.data.map((c) => ({ profileId: c.profile_id, kind: c.kind, wording: c.wording, at: c.at })),
        helpRequests,
        // Team changes need the 20 Oct (evening) database update; until then, none.
        teamLog: tl.error ? [] : tl.data.map((t) => ({ at: t.at, actorName: t.actor_name, targetName: t.target_name, change: t.change })),
        unregistered: ur.error ? [] : ur.data.map((u) => ({ email: u.email, signedUpAt: u.signed_up_at, lastSignInAt: u.last_sign_in_at })),
        pushPeople: pp.error ? [] : pp.data.map((x) => (typeof x === "string" ? x : x.push_people)),
      };
    },
    // ---- phone notifications
    async savePushSub({ endpoint, p256dh, auth, device }) { await rpc("save_push_sub", { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_device: device }); },
    /** Sends this person a test notification. Returns the sender's answer ({ sent, ... }) or null. */
    async pushTest() { await rpc("push_test"); return this.flushPush(); },
    async removePushSub(endpoint) { await rpc("remove_push_sub", { p_endpoint: endpoint }); },
    /** Leaders: queue messages for people (only those with notifications on get them). */
    async queuePush(items) {
      if (!items.length) return 0;
      return rpc("queue_push", { p_items: items.map((i) => ({ profile_id: i.profileId, title: i.title, body: i.body, tag: i.tag })) });
    },
    /** Asks the send-push function to send whatever is waiting. Never throws. */
    async flushPush() {
      if (!config.push?.publicKey) return null;
      try { const { data, error } = await sb.functions.invoke(config.push.functionName || "send-push", { body: {} }); if (error) throw error; return data; }
      catch (err) { console.warn("Couldn't send notifications", err); return null; }
    },
    /** Supervisor only: make someone 'leader' / 'assistant', or move them back to 'driver' / 'rider'. */
    async setTeamRole(id, role) { return rpc("set_team_role", { p_profile: id, p_role: role }); },
    /** Supervisor only: hand the supervisor role to a leader; myRole is what the supervisor becomes. */
    async handOverSupervisor(id, myRole) { return rpc("hand_over_supervisor", { p_profile: id, p_my_role: myRole }); },
    async savePlan(sunday, status, summary, assignments, waitlist) {
      await rpc("save_plan", { p_sunday: sunday, p_status: status, p_summary: summary || {}, p_assignments: assignments, p_waitlist: waitlist || [] });
    },
    async saveProfile(p) {
      const row = profileToRow(p);
      delete row.id; delete row.user_id; delete row.email;
      if (p.id) { fail(await from("profiles").update(row).eq("id", p.id)); return p.id; }
      const res = await from("profiles").insert({ role: "rider", ...row }).select("id").single();
      fail(res);
      return res.data.id;
    },
    /** Removes a rider or driver (and their requests and rides). Their plan goes back to draft. */
    async removePerson(id) { return rpc("remove_person", { p_id: id }); },
    async addRequest(riderId, sunday, { rideHome = false, note = null, extraPeople = 0, canSplit = false } = {}) {
      fail(await from("ride_requests").upsert({ rider_id: riderId, sunday, ride_home: rideHome, note, extra_people: extraPeople, can_split: canSplit, status: "requested" }, { onConflict: "rider_id,sunday" }));
    },
    async updateRequest(riderId, sunday, patch) {
      const row = {};
      if ("canSplit" in patch) row.can_split = patch.canSplit;
      if ("extraPeople" in patch) row.extra_people = patch.extraPeople;
      if ("note" in patch) row.note = patch.note;
      fail(await from("ride_requests").update(row).eq("rider_id", riderId).eq("sunday", sunday));
    },
    async removeRequest(riderId, sunday) {
      fail(await from("ride_requests").update({ status: "cancelled" }).eq("rider_id", riderId).eq("sunday", sunday));
    },
    async resolveAlert(id) { fail(await from("alerts").update({ resolved: true }).eq("id", id)); },

    // ---- services
    async services() {
      const res = await from("services").select("*").gte("service_date", new Date(Date.now() - 86400000).toISOString().slice(0, 10)).order("service_date");
      if (res.error) return []; // before the services database update
      return res.data.map((r) => ({ date: r.service_date, title: r.title || "", time: String(r.start_time || "").slice(0, 5), arriveBeforeMin: r.arrive_before_min,
        cutoff: r.cutoff, cancelled: !!r.cancelled, note: r.note || "" }));
    },
    async saveService(row) {
      fail(await from("services").upsert({ service_date: row.date, title: row.title || null, start_time: row.time, arrive_before_min: row.arriveBeforeMin,
        cutoff: row.cutoff || null, cancelled: !!row.cancelled, note: row.note || null, updated_at: new Date().toISOString() }, { onConflict: "service_date" }));
    },
    async deleteService(date) { fail(await from("services").delete().eq("service_date", date)); },

    // ---- last-minute requests
    async createHelpRequest(req, asks) {
      const res = await from("help_requests").insert({
        sunday: req.sunday, rider_name: req.riderName, rider_phone: req.riderPhone || null, address: req.address,
        neighbourhood: req.neighbourhood || null, postal_code: req.postalCode || null, lat: req.lat, lng: req.lng,
        seats: req.seats, pickup_min: req.pickupMin,
      }).select("id").single();
      fail(res);
      fail(await from("help_asks").insert(asks.map((a) => ({ request_id: res.data.id, driver_id: a.driverId, away_min: a.awayMin }))));
      return res.data.id;
    },
    async cancelHelpRequest(id) { fail(await from("help_requests").update({ status: "cancelled" }).eq("id", id)); },
    async myHelpRequests() {
      const res = await sb.rpc("my_help_requests");
      if (res.error) return []; // before the database update
      return res.data.map((h) => ({ id: h.id, sunday: h.sunday, riderName: h.rider_name, neighbourhood: h.neighbourhood, seats: h.seats,
        pickupMin: h.pickup_min, awayMin: h.away_min, status: h.status, myAnswer: h.my_answer, mine: h.mine, address: h.address, riderPhone: h.rider_phone }));
    },
    async answerHelp(id, answer) { return rpc("answer_help", { p_request: id, p_answer: answer }); },

    async locate(address, neighbourhood, geocoding) {
      return geocode(address, { neighbourhood, nominatimUrl: geocoding?.nominatimUrl, enabled: geocoding?.enabled !== false });
    },
  };
}
