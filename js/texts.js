// Ready-to-copy text messages. Nothing is sent automatically (that needs a paid service);
// the leader copies a message and pastes it into the group chat or a text.
// Group texts never include street addresses. The one-to-one driver text does (see CONFIG.texts).

import { CONFIG } from "./config.js";
import { fmtDate, fmtMin, toMin } from "./dates.js";
import { serviceFor, timeLabel, dayLabel, cutoffLabel } from "./services.js";

const first = (name = "") => String(name).trim().split(/\s+/)[0] || "friend";
const church = () => CONFIG.churchName;
/** Start time of the service on that day ("11:45 AM", or "10:00 AM" for a joint service). */
const svcLabel = (day) => (day ? timeLabel(day) : fmtMin(toMin(CONFIG.service.time)));

/** Invitation for people with a car to join the driving team. Safe for a group chat (no personal details). */
export function inviteDrivers(appUrl = "") {
  return `Hello from ${church()}! \u{1F49B}

Every Sunday, there are people in our church family who would love to worship with us but have no way to get there.

A simple ride from you can mean the world to them. It could be the difference between sitting at home and being in the house of God with their church family.

If you have a car and even one or two free seats, we would be so grateful to have you on our driving team.

This is a real way to serve, and no one here is a stranger for long. You'll get to know the people you drive, and they'll get to know you.

Joining takes about two minutes:

1. Open ${appUrl || "the ride app"}
2. Sign in with your email. We'll send you a short code, and there's no password to remember
3. Choose "I can give rides" and fill in the short form

Our transport leader will look over your details and approve you before you're given anyone to pick up. You decide which Sundays you drive, and you're always free to tell us when you can't. There's no pressure, and every ride counts.

Thank you for having a heart to serve. We can't wait to have you on the team!`;
}

export function weeklyCheckin(sunday, appUrl = "") {
  const sv = serviceFor(sunday);
  const which = sv.differs && sv.title !== "Sunday service" ? `to the ${sv.title} (${dayLabel(sunday).replace(`${sv.title}, `, "")}, ${svcLabel(sunday)})` : `this Sunday (${dayLabel(sunday)})`;
  return `Good day from ${church()}. Do you need a ride ${which}? Please tell us in the app by ${cutoffLabel(sunday)}, and how many people are coming with you${appUrl ? `: ${appUrl}` : ""}. If we don't hear from you, we won't arrange a ride.`;
}

export function riderDetails(sunday, rider, driver, stop, partyTotal = 1) {
  const who = partyTotal > 1 && (stop.seats ?? 1) < partyTotal ? `${stop.seats} of your group of ${partyTotal}` : partyTotal > 1 ? `your group of ${partyTotal}` : "you";
  return `Hi ${first(rider.name)}, your ride for ${dayLabel(sunday)} is arranged. ${first(driver.name)}${driver.vehicle ? ` (${driver.vehicle})` : ""} will ${who === "you" ? "pick you up" : `pick up ${who}`} around ${fmtMin(stop.pickupMin)}. Please be ready by ${fmtMin(stop.readyByMin)} to avoid delays.${driver.phone ? ` Driver's number: ${driver.phone}.` : ""} Service is at ${svcLabel(sunday)}.`;
}

export function waitlisted(sunday, rider) {
  return `Hi ${first(rider.name)}, we're still working on a seat for you on ${dayLabel(sunday)}. The transport leader will message you as soon as we have one. Thank you for your patience.`;
}

export function driverRoute(sunday, driver, cars, ridersById, groupSizes = new Map(), { rebooked = [] } = {}) {
  const details = CONFIG.texts?.includeDetails !== false;
  const van = !!driver.isVehicle;
  const lines = [`Hi ${first(driver.name)}, thank you for driving ${van ? "the church van " : ""}on ${dayLabel(sunday)}.`];
  if (rebooked.length) {
    const who = rebooked.length === 1 ? rebooked[0] : `${rebooked.slice(0, -1).join(", ")} and ${rebooked.at(-1)}`;
    lines.push(`Sorry for the back-and-forth: ${who} ${rebooked.length === 1 ? "is" : "are"} coming after all, so ${rebooked.length === 1 ? "they're" : "they're all"} back on your list.`);
  }
  // How many people, and when to leave so every pickup is on time and they reach church early.
  const people = cars.reduce((n, c) => n + c.stops.reduce((m, s) => m + (s.seats || 1), 0), 0);
  lines.push(`You have ${people} ${people === 1 ? "person" : "people"} to pick up.`);
  const leaveLine = (car) => {
    const leave = car.stops[0]?.departMin, arrive = car.stops[0]?.arriveMin;
    // The church van starts at church (pick it up there) unless the driver took it home.
    const from = car.trip > 1 ? "church" : van ? (driver.vanStart === "home" ? "home with the van" : "the church with the van") : "home";
    return leave != null
      ? `Please leave ${from} by ${fmtMin(leave)}${arrive != null ? ` to reach church by ${fmtMin(arrive)}` : ""} (service is at ${svcLabel(sunday)}).`
      : `Please leave ${from} in good time to reach your first pickup by ${fmtMin(car.stops[0]?.pickupMin)}${arrive != null ? ` and church by ${fmtMin(arrive)}` : ""}.`;
  };
  if (cars.length === 1) lines.push(leaveLine(cars[0]));
  for (const car of cars) {
    if (cars.length > 1) lines.push(`Trip ${car.trip}: ${leaveLine(car)}`);
    lines.push("Your pickups:");
    for (const s of car.stops) {
      const r = ridersById.get(s.riderId);
      const where = details
        ? [r?.address, r?.neighbourhood && !String(r?.address || "").includes(r.neighbourhood) ? `(${r.neighbourhood})` : ""].filter(Boolean).join(" ")
        : (r?.neighbourhood ? `(${r.neighbourhood})` : "");
      const phone = details && r?.phone ? `, ${r.phone}` : "";
      lines.push(`${fmtMin(s.pickupMin)}  ${r ? r.name : "Rider"}${where ? `, ${where}` : ""}${phone}`);
      const total = Math.max(groupSizes.get(s.riderId) || 1, s.seats || 1);
      const mine = s.seats || 1;
      if (total > 1) {
        lines.push(mine >= total
          ? `    ${total} people in this group, all riding with you.`
          : `    ${total} people in this group. You're taking ${mine}; the rest go with another driver from the same address. ${first(r?.name)} will sort out who rides with whom.`);
      }
    }
  }
  lines.push(details ? "Please keep these details private and don't forward them. The app has them too." : "Full details with addresses are in the app.");
  return lines.join("\n");
}

export function reminder(sunday) {
  const sv = serviceFor(sunday);
  return `Reminder from ${church()}: tomorrow's ${sv.differs && sv.title !== "Sunday service" ? sv.title : "service"} is at ${svcLabel(sunday)}. If you have a ride, please be ready by the time in your pickup message to avoid delays. If you can't make it, tell us in the app or message the transport leader.`;
}

export function driverCancelled(sunday, rider, newDriver, stop) {
  return newDriver
    ? `Hi ${first(rider.name)}, there's a change to your ride on ${dayLabel(sunday)}. ${first(newDriver.name)} will now pick you up around ${fmtMin(stop.pickupMin)}. Please be ready by ${fmtMin(stop.readyByMin)}. Sorry for the change.`
    : `Hi ${first(rider.name)}, your driver can't make it on ${dayLabel(sunday)} and we're looking for another ride for you. We'll message you shortly.`;
}

export function lastMinuteBroadcast(sunday, riderFirstName, neighbourhood, seatsNeeded = 1) {
  return `Last-minute help needed (${dayLabel(sunday)}): ${riderFirstName}${neighbourhood ? ` in ${neighbourhood}` : ""} needs a ride to church. Can anyone with ${seatsNeeded} free seat pick them up? Please reply to the transport leader.`;
}

/** One-to-one ask to a driver. Neighbourhood only: the full address is shared once they say yes. */
export function lastMinuteAsk(sunday, driver, riderName, neighbourhood, seats, awayMin, pickupMin) {
  return `Hi ${first(driver.name)}, a last-minute ride request for ${dayLabel(sunday)}: ${first(riderName)}${neighbourhood ? ` in ${neighbourhood}` : ""} needs a ride to church${seats > 1 ? ` (${seats} people)` : ""}. You're about ${awayMin} minutes from them. Could you pick them up around ${fmtMin(pickupMin)}? Please reply YES or NO, and I'll send you the address and details.`;
}

/** To the driver when one of their riders cancels. */
export function riderCancelledToDriver(sunday, driver, rider, othersLeft) {
  return `Hi ${first(driver.name)}, ${first(rider?.name)} has cancelled their ride for ${dayLabel(sunday)}, so you don't need to pick them up. ${othersLeft
    ? "I'll send your updated pickup list and leave time shortly."
    : "You have no pickups now. Thank you for being ready to help!"}`;
}

/** Short nudge with the link: the driver answers Yes or No in the app (address shared there only if they get the ride). */
export function helpAskText(sunday, driver, riderName, neighbourhood, seats, awayMin, pickupMin, appUrl = "") {
  return `Hi ${first(driver.name)}, a last-minute ride request for ${dayLabel(sunday)}: ${first(riderName)}${neighbourhood ? ` in ${neighbourhood}` : ""} needs a ride to church${seats > 1 ? ` (${seats} people)` : ""}, about ${awayMin} minutes from you, pickup around ${fmtMin(pickupMin)}. Can you help? Please tap Yes or No in the app: ${appUrl || "the ride app"}`;
}

/** Thank-you to the driver who said yes, with the details (they also see them in the app). */
export function helpConfirmText(sunday, driver, h) {
  return `Thank you, ${first(driver.name)}! You're picking up ${h.riderName} on ${dayLabel(sunday)} around ${fmtMin(h.pickupMin)} at ${h.address}${h.neighbourhood ? ` (${h.neighbourhood})` : ""}${h.riderPhone ? `. Their number: ${h.riderPhone}` : ""}. The details are in the app under My Sundays too.`;
}

/**
 * For the Chosen group chat when the leader changes a day: a joint service at another time,
 * a Sunday with no service, or a special service. Has no personal details.
 */
export function serviceAnnouncement(day, appUrl = "") {
  const sv = serviceFor(day);
  const date = fmtDate(day, { weekday: "long", month: "long", day: "numeric" });
  const link = appUrl ? `\n\nOpen the app: ${appUrl}` : "";
  if (sv.cancelled) {
    return `Announcement from ${church()}: there is no service on ${date}, so no rides will be arranged that day. If you had asked for a ride, there's nothing you need to do.${link}`;
  }
  const note = sv.note ? `\n${sv.note}` : "";
  if (sv.sunday) {
    return `Announcement from ${church()}: ${date} is a ${sv.title !== "Sunday service" ? sv.title : "service"} at ${svcLabel(day)}${sv.time !== CONFIG.service.time ? ` (not the usual ${svcLabel()})` : ""}.${note}

Need a ride? Ask in the app by ${cutoffLabel(day)}. If you've already asked, your pickup time will be worked out for the new time; you'll see it on Saturday evening.
Drivers: please check you're still free for it in the app.${link}`;
  }
  return `Announcement from ${church()}: ${sv.title} on ${date} at ${svcLabel(day)}.${note}

Need a ride? Open the app and tap "I need a ride" for the ${sv.title} by ${cutoffLabel(day)}.
Drivers: if you can give rides for it, please say so in the app. We'll only plan you in if you do.${link}`;
}
