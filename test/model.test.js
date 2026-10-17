// -----------------------------------------------------------------------------
// src/model.js: the answers -> next delivery, last order, cart, cut-off, and
// when to read again (pure).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approaching,
  isNear,
  nextDelay,
  parseTime,
  readCart,
  readCutOff,
  readLastOrder,
  readNextDelivery,
  readSnapshot,
  wallClock,
  withPosition,
} from '../src/model.js';
import { etaText } from '../src/devices.js';
import {
  DAY,
  HOUR,
  MINUTE,
  NEXT_START,
  NOW,
  cart,
  deliveries,
  delivery,
  paris,
} from './fixtures/picnic.js';

test('times keep the wall clock Picnic gives, whatever the offset', () => {
  assert.deepEqual(parseTime('2026-07-15T14:15:00.000+02:00'), {
    at: Date.parse('2026-07-15T12:15:00.000Z'),
    offset: 120,
    text: '2026-07-15 14:15',
  });
  assert.equal(parseTime('2026-12-01T08:00:00Z').offset, 0);
  assert.equal(parseTime('2026-12-01T08:00:00-0130').offset, -90);
  for (const bad of [
    undefined,
    null,
    12,
    '',
    'tomorrow',
    '2026-12-01T08:00:00',
    '2026-13-45T99:00:00Z',
  ]) {
    assert.equal(parseTime(bad), undefined, String(bad));
  }
  assert.equal(wallClock(Date.parse('2026-10-17T22:30:00Z'), 120), '2026-10-18 00:30');
});

test('the cart: articles and euros, nothing when Picnic sends nonsense', () => {
  assert.deepEqual(readCart(cart()), { count: 3, total: 12.34 });
  assert.deepEqual(readCart({ total_count: 0, total_price: 0 }), { count: 0, total: 0 });
  assert.deepEqual(readCart({ total_count: -1, total_price: 'x' }), {
    count: undefined,
    total: undefined,
  });
  assert.deepEqual(readCart(null), { count: undefined, total: undefined });
});

test('the next delivery is the CURRENT one with the earliest slot, not yet delivered', () => {
  const later = delivery({ id: 'd-later', start: NEXT_START + 3 * DAY });
  const done = delivery({ id: 'd-done', start: NOW - HOUR, deliveredAt: NOW - 30 * MINUTE });
  const next = readNextDelivery([later, done, ...deliveries()]);
  assert.equal(next.id, 'd-next');
  assert.equal(next.start.text, '2026-10-18 14:15');
  assert.equal(next.end.text, '2026-10-18 16:15');
  assert.equal(next.cutOff.text, '2026-10-17 23:00');
  assert.equal(next.arrival, undefined, 'no ETA yet');
  assert.equal(readNextDelivery([]), null);
  assert.equal(readNextDelivery('nonsense'), null);
  assert.equal(readNextDelivery([{ status: 'CURRENT', slot: {} }]), null);
});

test('a stale CURRENT delivery never hides the real next one', () => {
  const stale = delivery({ id: 'd-stale', start: NOW - 2 * DAY });
  assert.equal(readNextDelivery([stale, ...deliveries()], NOW).id, 'd-next');
  assert.equal(readNextDelivery([stale], NOW).id, 'd-stale', 'kept when it is the only one');
  // Still the next one up to 30 minutes after the end of its window.
  const late = delivery({ id: 'd-late', start: NOW - 2 * HOUR - 20 * MINUTE });
  assert.equal(readNextDelivery([late, ...deliveries()], NOW).id, 'd-late');
});

test('the ETA: eta2 of the summary, else the position, whose eta wins', () => {
  const eta2 = { start: paris(NEXT_START + 20 * MINUTE), end: paris(NEXT_START + 40 * MINUTE) };
  const next = readNextDelivery([delivery({ eta2 })]);
  assert.equal(next.arrival, NEXT_START + 20 * MINUTE);
  assert.equal(etaText(next), '2026-10-18 14:35 (14:35–14:55)');
  const live = withPosition(next, {
    eta_window: { start: paris(NEXT_START + 25 * MINUTE), end: paris(NEXT_START + 45 * MINUTE) },
    eta: NEXT_START + 33 * MINUTE,
  });
  assert.equal(live.arrival, NEXT_START + 33 * MINUTE);
  assert.equal(etaText(live), '2026-10-18 14:48 (14:40–15:00)');
  assert.equal(withPosition(next, undefined), next, 'an empty position changes nothing');
  assert.equal(etaText(null), '—');
});

test('the last order is the most recent delivery', () => {
  assert.deepEqual(readLastOrder(deliveries()), { id: 'd-next', status: 'CURRENT' });
  const [current, old, cancelled] = deliveries();
  assert.deepEqual(readLastOrder([cancelled, old]), { id: 'd-old', status: 'COMPLETED' });
  assert.equal(readLastOrder([]), null);
  assert.equal(current.status, 'CURRENT');
});

test('the cut-off: the booked delivery, else the selected slot, else the first one offered', () => {
  const next = readNextDelivery(deliveries());
  assert.equal(readCutOff(cart(), next, NOW).text, '2026-10-17 23:00');
  const late = NOW + 14 * HOUR;
  assert.equal(readCutOff(cart(), next, late).text, '2026-10-19 00:15');
  assert.equal(readCutOff(cart({ selected: 'EXPLICIT' }), next, late).text, '2026-10-20 00:15');
  assert.equal(readCutOff({}, null, NOW), undefined);
  assert.equal(readSnapshot({ cart: {}, deliveries: [] }, NOW).cutOff, null);
});

test('the reads: the interval, 5 minutes on the delivery day, 2 around the delivery', () => {
  const base = 15 * MINUTE;
  const next = readNextDelivery(deliveries());
  assert.equal(nextDelay(null, NOW, base), base);
  assert.equal(nextDelay(next, NEXT_START - 2 * DAY, base), base);
  assert.equal(nextDelay(next, NEXT_START - 6 * HOUR, base), 5 * MINUTE);
  assert.equal(
    nextDelay(next, NEXT_START - 48 * MINUTE, base),
    3 * MINUTE,
    'not past the near window',
  );
  assert.equal(nextDelay(next, NEXT_START - 45 * MINUTE, base), 2 * MINUTE);
  assert.equal(nextDelay(next, NEXT_START + 2 * HOUR + 29 * MINUTE, base), 2 * MINUTE);
  assert.equal(nextDelay(next, NEXT_START + 3 * HOUR, base), base);
  assert.equal(nextDelay(next, NEXT_START - 12 * HOUR - 50 * MINUTE, 60 * MINUTE), 50 * MINUTE);
  assert.equal(isNear(next, NEXT_START - 46 * MINUTE), false);
  assert.equal(isNear(next, NEXT_START), true);
});

test('"approaching": only with an ETA, within the lead, until the window ends', () => {
  const lead = 15 * MINUTE;
  const next = readNextDelivery(deliveries());
  assert.equal(approaching(next, NEXT_START, lead), null, 'no ETA, no event');
  const live = withPosition(next, { eta: NEXT_START + 30 * MINUTE });
  assert.equal(approaching(live, NEXT_START, lead), null, '30 minutes away');
  assert.deepEqual(approaching(live, NEXT_START + 16 * MINUTE, lead), { minutes: 14 });
  assert.deepEqual(approaching(live, NEXT_START + 40 * MINUTE, lead), { minutes: 0 });
  assert.equal(approaching(live, NEXT_START + 2 * HOUR, lead), null, 'over');
});
