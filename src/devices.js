// -----------------------------------------------------------------------------
// The account -> one Gladys device and its states (pure).
//
// `ext:<selector>:account:<Picnic user id>` (else `<country>-<hash of the
// e-mail>`, see deviceKeyOf): one device per Picnic account, read only. Gladys has no date feature: the slot, the ETA
// and the cut-off are `text` features showing the local time Picnic gives
// ("2026-10-18 14:15"). The cart total is a `currency` in euros (the only
// currency of the four countries), the number of articles a generic sensor
// without unit (the core lists none for a count).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_NAME, FEATURE_NAMES, NONE, STATUS_NAMES, word } from './i18n.js';
import { offsetFor, wallClock } from './model.js';

const text = { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false };

/** The features, by role (the last part of their external id), in display order. */
export const FEATURES = {
  'next-slot-start': text,
  'next-slot-end': text,
  eta: text,
  'order-cut-off': text,
  'last-order-status': text,
  'cart-items': { category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 1000 },
  'cart-total': {
    category: C.CURRENCY,
    type: T.CURRENCY.DECIMAL,
    unit: U.EURO,
    min: 0,
    max: 10000,
  },
};

/**
 * The device key of an account: the Picnic `user_id` of the sign-in (Home
 * Assistant's unique id), else `<country>-<hash of the e-mail>` from the
 * account key of src/config.js. Chosen once per account and kept in /data.
 */
export const deviceKeyOf = (account, userId) => userId ?? account.replace(':', '-').toLowerCase();

export const accountIds = (gladys, key) => gladys.externalIds('account', key);

export function buildDevice(gladys, key, { language, country }) {
  const ids = accountIds(gladys, key);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    features: Object.entries(FEATURES).map(([role, definition]) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...definition,
    })),
    params: [{ name: 'country', value: country }],
  };
}

export const statusName = (status, language) =>
  status ? (STATUS_NAMES[status] ? word(STATUS_NAMES[status], language) : status) : undefined;

/** The estimated arrival: "2026-10-18 14:32", with the ETA window when Picnic gives one. */
export function etaText(next) {
  if (!next || next.arrival === undefined) {
    return NONE;
  }
  const offset = offsetFor(next);
  const at = wallClock(next.arrival, offset);
  const { start, end } = next.eta ?? {};
  if (start && end) {
    return `${at} (${wallClock(start.at, offset).slice(11)}–${wallClock(end.at, offset).slice(11)})`;
  }
  return at;
}

/** The current values of the account device (sent when they change). */
export function deviceStates(ids, snapshot, language) {
  const { next, lastOrder, cart, cutOff } = snapshot;
  const states = [
    ['next-slot-start', { text: next?.start?.text ?? NONE }],
    ['next-slot-end', { text: next?.end?.text ?? NONE }],
    ['eta', { text: etaText(next) }],
    ['order-cut-off', { text: cutOff?.text ?? NONE }],
    ['last-order-status', { text: statusName(lastOrder?.status, language) ?? NONE }],
  ];
  if (cart.count !== undefined) {
    states.push(['cart-items', { state: cart.count }]);
  }
  if (cart.total !== undefined) {
    states.push(['cart-total', { state: cart.total }]);
  }
  return states.map(([role, value]) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
