// -----------------------------------------------------------------------------
// Picnic answers -> what Gladys shows (pure): the next delivery (slot, order
// cut-off, estimated arrival), the last order, the cart, and when to read
// again. The choices follow the Picnic integration of Home Assistant
// (Apache-2.0): the next delivery is a CURRENT one, the last order the most
// recent delivery, the live ETA the `eta_window` of the position (else the
// `eta2` of the summary), the polling faster around the delivery.
//
// Times stay those of Picnic: ISO strings with their offset
// ("2026-10-18T14:15:00.000+02:00"), shown as the local wall clock they carry
// ("2026-10-18 14:15"), whatever the time zone of the container.
// -----------------------------------------------------------------------------

import { DELIVERY_STATUS, MINUTE, TIMINGS } from './constants.js';

const TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

const offsetOf = (zone) => {
  if (zone === 'Z') {
    return 0;
  }
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
};

/** "YYYY-MM-DD HH:mm" of an instant, at a UTC offset in minutes. */
export const wallClock = (ms, offset = 0) =>
  new Date(ms + offset * MINUTE).toISOString().slice(0, 16).replace('T', ' ');

/** An ISO time with its offset -> { at (ms), offset (min), text }; undefined otherwise. */
export function parseTime(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = TIME.exec(value.trim());
  const at = Date.parse(value);
  if (!match || Number.isNaN(at)) {
    return undefined;
  }
  return { at, offset: offsetOf(match[3]), text: `${match[1]} ${match[2]}` };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
const idOf = (value) =>
  typeof value === 'string' && value !== ''
    ? value.slice(0, 100)
    : typeof value === 'number'
      ? String(value)
      : undefined;

/** The cart: number of articles and total in euros (Picnic sends cents). */
export function readCart(cart) {
  const count = Number(cart?.total_count);
  const cents = Number(cart?.total_price);
  return {
    count: Number.isInteger(count) && count >= 0 ? count : undefined,
    total: Number.isFinite(cents) && cents >= 0 ? Math.round(cents) / 100 : undefined,
  };
}

const delivered = (delivery) => parseTime(delivery?.delivery_time?.start) !== undefined;

/** The ETA window of the summary (`eta2`) or of the position (`eta_window`). */
function etaOf(window) {
  const start = parseTime(window?.start);
  const end = parseTime(window?.end);
  return start ? { start, end } : undefined;
}

/**
 * The next delivery: the CURRENT, not yet delivered one with the earliest
 * slot (Home Assistant takes the last CURRENT of the list, the same one when
 * the list is sorted the most recent first).
 */
export function readNextDelivery(deliveries) {
  const next = list(deliveries)
    .filter((d) => d.status === DELIVERY_STATUS.CURRENT && !delivered(d))
    .map((d) => ({
      id: idOf(d.delivery_id ?? d.id),
      start: parseTime(d.slot?.window_start),
      end: parseTime(d.slot?.window_end),
      cutOff: parseTime(d.slot?.cut_off_time),
      eta: etaOf(d.eta2),
    }))
    .filter((d) => d.id && d.start)
    .sort((a, b) => a.start.at - b.start.at)[0];
  if (!next) {
    return null;
  }
  return { ...next, arrival: next.eta?.start.at };
}

/** The live position, when Picnic has one: its ETA window and its `eta` (ms). */
export function withPosition(next, position) {
  if (!next || !isObject(position)) {
    return next;
  }
  const eta = etaOf(position.eta_window) ?? next.eta;
  const at = Number(position.eta);
  const arrival = Number.isFinite(at) && at > 0 ? at : eta?.start.at;
  return { ...next, eta, arrival };
}

/** The last order: the most recent delivery, its status. */
export function readLastOrder(deliveries) {
  const all = list(deliveries);
  if (all.length === 0) {
    return null;
  }
  const dated = all
    .map((d, index) => ({ d, index, at: parseTime(d.creation_time)?.at }))
    .filter((e) => e.at !== undefined)
    .sort((a, b) => b.at - a.at || a.index - b.index);
  const last = dated[0]?.d ?? all[0];
  const status = typeof last.status === 'string' ? last.status.slice(0, 40) : undefined;
  return { id: idOf(last.delivery_id ?? last.id), status };
}

/**
 * The order cut-off of the next slot: the booked delivery's while it can
 * still be changed, else the slot selected in the cart, else the first slot
 * the cart offers. Only cut-offs still to come.
 */
export function readCutOff(cart, next, now) {
  if (next?.cutOff && next.cutOff.at > now) {
    return next.cutOff;
  }
  const slots = list(cart?.delivery_slots)
    .map((s) => ({
      id: idOf(s.slot_id),
      start: parseTime(s.window_start),
      cutOff: parseTime(s.cut_off_time),
      available: s.is_available !== false,
    }))
    .filter((s) => s.cutOff && s.cutOff.at > now);
  const selected = cart?.selected_slot;
  if (selected?.state === 'EXPLICIT') {
    const slot = slots.find((s) => s.id && s.id === idOf(selected.slot_id));
    if (slot) {
      return slot.cutOff;
    }
  }
  const first = slots
    .filter((s) => s.available && s.start)
    .sort((a, b) => a.start.at - b.start.at)[0];
  return first?.cutOff;
}

/** Everything one cycle read. */
export function readSnapshot({ cart, deliveries, position }, now) {
  const next = withPosition(readNextDelivery(deliveries), position);
  return {
    cart: readCart(cart),
    next,
    lastOrder: readLastOrder(deliveries),
    cutOff: readCutOff(cart, next, now) ?? null,
  };
}

/** The time window of the next delivery: its slot, widened by its ETA when known. */
export function deliveryWindow(next) {
  if (!next) {
    return undefined;
  }
  const times = [next.start.at, next.end?.at, next.eta?.start.at, next.eta?.end?.at, next.arrival];
  const known = times.filter((t) => Number.isFinite(t));
  const start = Math.min(...known);
  // A slot without an end (never seen) lasts two hours, like Picnic's slots.
  const fallback = next.end || next.eta?.end ? [] : [start + 2 * 60 * MINUTE];
  return { start, end: Math.max(...known, ...fallback) };
}

/** Around the delivery: the live position is read, every 2 minutes. */
export function isNear(next, now) {
  const window = deliveryWindow(next);
  return (
    Boolean(window) && now >= window.start - TIMINGS.nearLead && now <= window.end + TIMINGS.nearLag
  );
}

/**
 * The delay before the next read: the configured interval; 5 minutes on the
 * delivery day (12 h before the slot); 2 minutes around the delivery; never
 * past the start of a closer window, never under a minute.
 */
export function nextDelay(next, now, base) {
  const window = deliveryWindow(next);
  if (!window || now > window.end + TIMINGS.nearLag) {
    return base;
  }
  if (now >= window.start - TIMINGS.nearLead) {
    return TIMINGS.nearInterval;
  }
  const untilNear = window.start - TIMINGS.nearLead - now;
  const untilDay = window.start - TIMINGS.dayLead - now;
  const interval = untilDay <= 0 ? Math.min(base, TIMINGS.dayInterval) : Math.min(base, untilDay);
  return Math.max(TIMINGS.minInterval, Math.min(interval, untilNear));
}

/**
 * The "delivery approaching" moment: an ETA is known (the API gives one) and
 * it is at most `lead` ms away, and the delivery window is not over.
 * Resolves `{ minutes }`, or null.
 */
export function approaching(next, now, lead) {
  if (!next || next.arrival === undefined) {
    return null;
  }
  const end = next.eta?.end?.at ?? next.arrival + TIMINGS.nearLag;
  if (now > Math.max(end, next.arrival)) {
    return null;
  }
  const left = next.arrival - now;
  return left <= lead ? { minutes: Math.max(0, Math.round(left / MINUTE)) } : null;
}

/** The offset to show an instant with: the one of the slot, UTC otherwise. */
export const offsetFor = (next) => next?.eta?.start.offset ?? next?.start?.offset ?? 0;
