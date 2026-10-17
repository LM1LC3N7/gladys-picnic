// -----------------------------------------------------------------------------
// Made-up Picnic answers, shaped like the fixtures of python-picnic-api2
// (tests/fixtures: cart_de.json, current_deliveries_de.json, delivery_de.json)
// and the fields the Home Assistant integration reads. No real account.
// -----------------------------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 2026-10-17 10:00 in Paris (UTC+2 until the 25th). */
export const NOW = Date.parse('2026-10-17T08:00:00.000Z');
export const EMAIL = 'jane@example.com';
export const PASSWORD = 'pä55 "word"';
export const COUNTRY = 'FR';
export const DID = 'ABCDEF0123456789';
export const CODE = '123456';

/** An unsigned JWT with these claims. */
export const jwt = (claims) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** "2026-10-18T14:15:00.000+02:00" for an instant, in Paris summer time. */
export const paris = (ms) => `${new Date(ms + 2 * HOUR).toISOString().slice(0, 23)}+02:00`;

const slot = (
  start,
  { id = 'slot-1', hours = 2, cutOff = start - 15 * HOUR, available = true } = {},
) => ({
  slot_id: id,
  hub_id: 'HUB',
  fc_id: 'FC0',
  window_start: paris(start),
  window_end: paris(start + hours * HOUR),
  cut_off_time: paris(cutOff),
  is_available: available,
  selected: false,
  reserved: false,
  minimum_order_value: 3500,
  slot_characteristics: [],
});

/** The next delivery: tomorrow 14:15 to 16:15 (Paris), to order before tonight 23:00. */
export const NEXT_START = Date.parse('2026-10-18T12:15:00.000Z');

export function cart({ count = 3, cents = 1234, selected = 'IMPLICIT' } = {}) {
  return {
    type: 'ORDER',
    id: 'cart-1',
    items: [],
    delivery_slots: [
      slot(NEXT_START + DAY, { id: 'slot-2', cutOff: NEXT_START + DAY - 14 * HOUR }),
      slot(NEXT_START + 2 * DAY, { id: 'slot-3', cutOff: NEXT_START + 2 * DAY - 14 * HOUR }),
    ],
    selected_slot: { slot_id: 'slot-3', state: selected },
    total_count: count,
    total_price: cents,
    checkout_total_price: cents,
    deposit_breakdown: [],
    membership_savings: 0,
  };
}

export function delivery({
  id = 'd-next',
  status = 'CURRENT',
  start = NEXT_START,
  created = NOW - 14 * HOUR,
  eta2 = null,
  deliveredAt,
  total = 4996,
} = {}) {
  return {
    delivery_id: id,
    creation_time: paris(created),
    slot: slot(start, { id: `slot-${id}`, cutOff: Date.parse('2026-10-17T21:00:00.000Z') }),
    eta2,
    delivery_time: deliveredAt
      ? { start: paris(deliveredAt), end: paris(deliveredAt + 5 * MINUTE) }
      : null,
    status,
    orders: [
      {
        type: 'ORDER',
        id: `order-${id}`,
        creation_time: paris(created),
        total_price: total,
        status,
        cancellation_time: null,
      },
    ],
  };
}

/** The summary list, the most recent first: the next one, a delivered one, a cancelled one. */
export function deliveries() {
  return [
    delivery(),
    delivery({
      id: 'd-old',
      status: 'COMPLETED',
      start: NOW - 7 * DAY,
      created: NOW - 8 * DAY,
      deliveredAt: NOW - 7 * DAY + 30 * MINUTE,
    }),
    delivery({
      id: 'd-cancelled',
      status: 'CANCELLED',
      start: NOW - 20 * DAY,
      created: NOW - 21 * DAY,
    }),
  ];
}
