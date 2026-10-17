// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Picnic behind the transport. Timers and Date are mocked:
// the tests move the clock minute by minute.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PicnicApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import {
  CODE,
  COUNTRY,
  DAY,
  DID,
  EMAIL,
  HOUR,
  MINUTE,
  NEXT_START,
  NOW,
  PASSWORD,
  paris,
} from './fixtures/picnic.js';
import { fakePicnic, memoryStore, settle } from './helpers/fakePicnic.js';

const CONFIG = { email: EMAIL, password: PASSWORD, country: COUNTRY };
const ACCOUNT = `${COUNTRY}:${accountKey(EMAIL)}`;
/** The device key is the Picnic user id of the sign-in. */
const DEVICE = 'ext:test-integration:account:user-1';
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakePicnic(),
    now = NOW,
    create = true,
    logs = [],
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const app = new PicnicApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
    randomDid: () => DID,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
      t.mock.timers.tick(30_000);
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  return { gladys, app, server, store, advance };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};

test('without credentials or country, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server, store } = await setup(t, {
    config: { email: EMAIL, password: PASSWORD, country: 'ES' },
  });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /e-mail, the password and the country/);
  assert.equal(store.data.did, DID, 'the device id is made once');
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /pays de votre compte Picnic/);
});

test('one sign-in, then the cart and the deliveries: the device, its states, the status', async (t) => {
  const { gladys, server, store } = await setup(t);
  assert.deepEqual(
    server.requests.map((r) => `${r.method} ${r.path}`),
    ['POST /user/login', 'GET /cart', 'POST /deliveries/summary'],
  );
  const [login] = server.logins();
  assert.equal(login.host, 'storefront-prod.fr.picnicinternational.com');
  assert.deepEqual(login.body, {
    key: EMAIL,
    secret: createHash('md5').update(PASSWORD, 'utf8').digest('hex'),
    client_id: 30100,
  });
  assert.equal(login.headers['x-picnic-did'], DID);
  assert.equal(login.headers['x-picnic-agent'], '30100;1.206.1-#15408');
  assert.equal(server.reads()[0].headers['x-picnic-did'], DID, 'the cart carries the app headers');
  assert.equal(server.of('/deliveries/summary')[0].body.length, 0, 'POST [] lists them all');
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD), 'the password never reaches /data');
  assert.ok(!JSON.stringify(store.data).includes(EMAIL), 'nor the e-mail');
  assert.equal(store.data.session.account, ACCOUNT);

  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Picnic');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
    ]),
    [
      ['next-slot-start', 'text', 'text', undefined],
      ['next-slot-end', 'text', 'text', undefined],
      ['eta', 'text', 'text', undefined],
      ['order-cut-off', 'text', 'text', undefined],
      ['last-order-status', 'text', 'text', undefined],
      ['cart-items', 'unknown', 'unknown', undefined],
      ['cart-total', 'currency', 'decimal', 'euro'],
    ],
  );
  assert.ok(device.features.every((f) => f.read_only === true));
  assert.equal(device.features[0].name, 'Prochaine livraison : début du créneau');

  assert.equal(last(gladys, 'next-slot-start'), '2026-10-18 14:15');
  assert.equal(last(gladys, 'next-slot-end'), '2026-10-18 16:15');
  assert.equal(last(gladys, 'eta'), '—');
  assert.equal(last(gladys, 'order-cut-off'), '2026-10-17 23:00');
  assert.equal(last(gladys, 'last-order-status'), 'À venir');
  assert.equal(last(gladys, 'cart-items'), 3);
  assert.equal(last(gladys, 'cart-total'), 12.34);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /Next delivery: 2026-10-18 14:15/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('every 15 minutes, with the same session', async (t) => {
  const { server, advance } = await setup(t);
  await advance(45 * MINUTE);
  assert.equal(server.reads().length, 4);
  assert.equal(server.logins().length, 1, 'no sign-in per cycle');
});

test('a token renewed in an answer header replaces the session', async (t) => {
  const { server, store, advance } = await setup(t);
  const renewed = server.issue();
  server.queue.push({
    match: (r) => r.path === '/cart',
    status: 200,
    body: server.cart,
    headers: { 'x-picnic-auth': renewed },
  });
  await advance(15 * MINUTE);
  assert.equal(store.data.session.token, renewed);
  await advance(15 * MINUTE);
  assert.equal(server.reads().at(-1).token, renewed);
});

test('a restart reuses the session of the same account only', async (t) => {
  const server = fakePicnic();
  const token = server.issue();
  const store = memoryStore({ did: DID, session: { account: ACCOUNT, token } });
  const { gladys } = await setup(t, { server, store });
  assert.equal(server.logins().length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);

  const other = fakePicnic();
  const foreign = memoryStore({ did: DID, session: { account: `NL:${accountKey(EMAIL)}`, token } });
  t.mock.timers.reset();
  await setup(t, { server: other, store: foreign });
  assert.equal(other.logins().length, 1, 'the session of another country is not used');
});

test('a refused token: one new sign-in and one retry, then the reads go on', async (t) => {
  const { server, advance } = await setup(t);
  server.revoke();
  await advance(15 * MINUTE);
  assert.equal(server.logins().length, 2);
  assert.equal(server.reads().length, 3, 'refused, then retried once');
  await advance(15 * MINUTE);
  assert.equal(server.logins().length, 2);
});

test('refused again after the new sign-in: a pause, a message, the test button retries at once', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.revoke();
  const refuse = {
    match: (r) => r.path === '/cart',
    status: 401,
    body: { error: { code: 'AUTH_ERROR' } },
  };
  server.queue.push(refuse, refuse);
  await advance(15 * MINUTE);
  assert.equal(server.logins().length, 2, 'one new sign-in only');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /refused the session again/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /New try \(one sign-in\) in 60 min/);
  assert.match(message(gladys).fr, /Nouvel essai \(une connexion\) dans 60 min/);
  const count = server.requests.length;
  await advance(59 * MINUTE);
  assert.equal(server.requests.length, count, 'paused');

  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Next delivery: 2026-10-18 14:15/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused password stops until the configuration changes; a reconnection keeps the stop', async (t) => {
  const server = fakePicnic();
  server.secret = 'something else';
  const { gladys, app, advance } = await setup(t, { server });
  assert.equal(server.logins().length, 1);
  assert.match(message(gladys).en, /refused the e-mail or the password/);
  await advance(2 * HOUR);
  assert.equal(server.logins().length, 1, 'never signed in again by itself');

  await app.connected(CONFIG);
  await advance(HOUR);
  assert.equal(server.logins().length, 1, 'a Gladys reconnection does not lift the stop');

  server.secret = createHash('md5').update('new password', 'utf8').digest('hex');
  await gladys.fake.configUpdated({ ...CONFIG, password: 'new password' });
  await settle();
  assert.equal(server.logins().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('two-step verification: nothing sent by itself, then the code requested and verified', async (t) => {
  const server = fakePicnic({ twoFactor: true });
  const store = memoryStore();
  const { gladys, advance } = await setup(t, { server, store });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /asks for a verification code/);
  assert.match(message(gladys).fr, /Envoyer le code de vérification/);
  assert.equal(server.of('/user/2fa/generate').length, 0, 'no SMS without the button');
  assert.equal(server.reads().length, 0);
  assert.ok(store.data.pending.token, 'the waiting sign-in survives a restart');
  await advance(HOUR);
  assert.equal(server.logins().length, 1, 'waits for the user');

  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'email' });
  assert.match(ack.data.message.en, /by e-mail/);
  assert.equal(server.logins().length, 2, 'the old waiting sign-in was too old: a new one');
  assert.deepEqual(server.of('/user/2fa/generate')[0].body, { channel: 'EMAIL' });
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /less than a minute ago/);
  assert.equal(server.of('/user/2fa/generate').length, 1);

  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: '000000' });
  assert.match(ack.data.message.en, /refused the code/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: 'abc' });
  assert.match(ack.data.message.en, /4 to 10 digits/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, {
    code: ` ${CODE.slice(0, 3)} ${CODE.slice(3)} `,
  });
  assert.match(ack.data.message.en, /Code accepted/);
  await settle();
  assert.equal(server.reads().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.pending, null);
  assert.ok(server.tokens.has(store.data.session.token), 'the verified token is the session');
  await advance(15 * MINUTE);
  assert.equal(server.logins().length, 2);
  assert.equal(server.reads().length, 2);

  // A restart keeps the verified session: no code again.
  t.mock.timers.reset();
  const again = await setup(t, { server, store });
  assert.equal(server.logins().length, 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
});

test('the code buttons refuse what they cannot use', async (t) => {
  const { gladys, server } = await setup(t);
  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /update Gladys/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /No sign-in is waiting/);
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /Already connected/);
  assert.equal(server.logins().length, 1, 'a working session is never put at risk');
  assert.equal(server.of('/user/2fa/generate').length, 0);
});

test('a 401 during the polling that asks for a code stops and says so', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.revoke();
  server.twoFactor = true;
  await advance(15 * MINUTE);
  assert.match(message(gladys).en, /asks for a verification code/);
  const count = server.requests.length;
  await advance(2 * HOUR);
  assert.equal(server.requests.length, count);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /asks for a verification code/);
  assert.equal(server.requests.length, count, 'the test button does not sign in again');
});

test('429: a bounded pause for every path, buttons included', async (t) => {
  const { gladys, app, server, advance } = await setup(t);
  server.queue.push({
    match: (r) => r.path === '/cart',
    status: 429,
    body: '',
    headers: { 'retry-after': '1' },
  });
  await advance(15 * MINUTE);
  assert.match(message(gladys).en, /pausing for 1 min/, 'Retry-After 1 s is raised to a minute');
  server.queue.push({
    match: (r) => r.path === '/cart',
    status: 429,
    body: '',
    headers: { 'retry-after': '999999' },
  });
  await advance(MINUTE);
  assert.match(message(gladys).en, /pausing for 6 h/, 'capped at 6 hours');
  const count = server.requests.length;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /slow down/);
  const code = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(code.data.message.en, /No sign-in is waiting/);
  // A Gladys reconnection during the pause keeps it.
  await app.connected(CONFIG);
  await advance(5 * HOUR);
  assert.equal(server.requests.length, count);
  await advance(HOUR + MINUTE);
  assert.ok(server.requests.length > count);
});

test('5xx: the reads go on after a short pause', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.queue.push({ match: (r) => r.path === '/deliveries/summary', status: 503, body: '' });
  await advance(15 * MINUTE);
  assert.match(message(gladys).en, /cannot be reached.*Next try in 2 min/);
  await advance(2 * MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('delivery day: every 5 minutes, then every 2 with the live position, and one "approaching" event', async (t) => {
  const server = fakePicnic();
  const store = memoryStore();
  const { gladys, advance } = await setup(t, { server, store, now: NEXT_START - 6 * HOUR });
  const reads = () => server.reads().length;
  await advance(5 * MINUTE);
  assert.equal(reads(), 2, 'every 5 minutes on the delivery day');
  assert.equal(server.of('/deliveries/d-next/position').length, 0, 'no position that early');

  const arrival = NEXT_START + 40 * MINUTE;
  server.position = {
    eta_window: { start: paris(arrival - 10 * MINUTE), end: paris(arrival + 10 * MINUTE) },
    eta: arrival,
  };
  // From 45 minutes before the slot: every 2 minutes, with the position.
  await advance(6 * HOUR - 45 * MINUTE - 5 * MINUTE);
  const before = reads();
  await advance(10 * MINUTE);
  assert.equal(reads() - before, 5);
  assert.ok(server.of('/deliveries/d-next/position').length >= 5);
  assert.equal(last(gladys, 'eta'), '2026-10-18 14:55 (14:45–15:05)');
  assert.equal(gladys.fake.sceneEvents.length, 0, 'not yet: 15 minutes before the arrival');

  // The reads run every 2 minutes from 13:30 (Paris): the one of 14:40 is 15 minutes before.
  await advance(61 * MINUTE);
  assert.equal(gladys.fake.sceneEvents.length, 1);
  const [event] = gladys.fake.sceneEvents;
  assert.equal(event.key, SCENE_TRIGGERS.DELIVERY_APPROACHING);
  assert.equal(event.data.eta, '2026-10-18 14:55');
  assert.equal(event.data.slot_start, '2026-10-18 14:15');
  assert.equal(event.data.slot_end, '2026-10-18 16:15');
  assert.ok(event.data.minutes <= 15 && event.data.minutes >= 10);
  assert.deepEqual(store.data.announced, ['d-next']);
  await advance(20 * MINUTE);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'once per delivery');
});

test('a failing position never hides the cart and the deliveries', async (t) => {
  const server = fakePicnic();
  server.queue.push({ match: (r) => r.path.endsWith('/position'), status: 500, body: '' });
  const { gladys } = await setup(t, { server, now: NEXT_START - 10 * MINUTE });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'next-slot-start'), '2026-10-18 14:15');
  assert.equal(last(gladys, 'eta'), '—');
});

test('the cut-off moves to the cart slot once the booked one has passed', async (t) => {
  const server = fakePicnic();
  server.cart.selected_slot.state = 'EXPLICIT';
  const { gladys } = await setup(t, { server, now: NOW + 14 * HOUR });
  // slot-3, selected (EXPLICIT) in the cart: 2026-10-20 14:15, to order before 00:15.
  assert.equal(last(gladys, 'order-cut-off'), '2026-10-20 00:15');
  server.cart.selected_slot.state = 'IMPLICIT';
  await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(last(gladys, 'order-cut-off'), '2026-10-19 00:15', 'else the first slot offered');
  assert.ok(NEXT_START + DAY > Date.now());
});

test('a new language renames the device and translates the status', async (t) => {
  const { gladys } = await setup(t);
  await gladys.fake.configUpdated({ ...CONFIG, language: 'en' });
  await settle();
  assert.equal(gladys.fake.discoveredDevices.at(-1).features[0].name, 'Next delivery: slot start');
  assert.equal(last(gladys, 'last-order-status'), 'Upcoming');
});

test('read only: a command is refused', async (t) => {
  const { gladys } = await setup(t);
  const device = gladys.fake.discoveredDevices[0];
  const ack = await gladys.fake.setValue(device, device.features[0], 'x');
  assert.equal(ack.success, false);
});

const is = (path) => (r) => r.path === path;
const GENERATE = '/user/2fa/generate';
const VERIFY = '/user/2fa/verify';

test('a session refused twice: one new try after 1 h, 6 h, then every 24 h, never a code', async (t) => {
  const server = fakePicnic();
  server.rejectData = true;
  const { gladys, advance } = await setup(t, { server });
  assert.equal(server.logins().length, 1);
  assert.match(message(gladys).en, /refused the session again/);
  await advance(HOUR - MINUTE);
  assert.equal(server.logins().length, 1);
  await advance(2 * MINUTE);
  assert.equal(server.logins().length, 2, 'one sign-in after an hour');
  assert.match(message(gladys).en, /in 6 h/);
  await advance(6 * HOUR);
  assert.equal(server.logins().length, 3);
  assert.match(message(gladys).en, /in 24 h/);
  await advance(24 * HOUR);
  assert.equal(server.logins().length, 4);
  server.twoFactor = true;
  await advance(24 * HOUR);
  assert.equal(server.logins().length, 5);
  assert.match(message(gladys).en, /asks for a verification code/);
  await advance(48 * HOUR);
  assert.equal(server.logins().length, 5, 'a code asked: stopped');
  assert.equal(server.of(GENERATE).length, 0, 'never an SMS by itself');
});

test('a refused token on the position is ignored: the session and the reads go on', async (t) => {
  const server = fakePicnic();
  server.queue.push({
    match: (r) => r.path.endsWith('/position'),
    status: 401,
    body: { error: { code: 'AUTH_ERROR' } },
  });
  const store = memoryStore();
  const { gladys, advance } = await setup(t, { server, store, now: NEXT_START - 10 * MINUTE });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(server.tokens.has(store.data.session.token), 'the session is kept');
  await advance(2 * MINUTE);
  assert.equal(server.logins().length, 1, 'no new sign-in');
  assert.equal(server.reads().length, 2);
  assert.equal(server.of('/deliveries/d-next/position').length, 2);
});

test('a sign-in request rejected (400) asks to update the integration and stops', async (t) => {
  const server = fakePicnic();
  server.queue.push({ match: is('/user/login'), status: 400, body: { error: { code: 'BAD' } } });
  const { gladys, advance } = await setup(t, { server });
  assert.match(
    message(gladys).en,
    /rejected the sign-in request \(HTTP 400\).*update the integration/,
  );
  assert.match(message(gladys).fr, /Connexion refusée par Picnic \(HTTP 400\)/);
  await advance(2 * HOUR);
  assert.equal(server.logins().length, 1);
});

test('the test button signs in at most once per 30 s, even without any read yet', async (t) => {
  const server = fakePicnic();
  server.secret = 'something else';
  const { gladys } = await setup(t, { server });
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /refused the e-mail/);
  assert.equal(server.logins().length, 2);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /less than 30 seconds ago.*refused the e-mail/);
  assert.equal(server.logins().length, 2);
});

test('a 429 pause survives a change of account and a restart', async (t) => {
  const store = memoryStore();
  const { gladys, server, advance } = await setup(t, { store });
  server.queue.push({
    match: is('/cart'),
    status: 429,
    body: '',
    headers: { 'retry-after': '3600' },
  });
  await advance(15 * MINUTE);
  assert.ok(store.data.rateLimitedUntil > Date.now() + 59 * MINUTE);
  const count = server.requests.length;
  await gladys.fake.configUpdated({ ...CONFIG, country: 'NL' });
  await settle();
  assert.equal(server.requests.length, count, 'the new account waits too');
  assert.match(message(gladys).en, /slow down/);

  const later = Date.now();
  t.mock.timers.reset();
  const again = await setup(t, { store, server, now: later });
  assert.equal(server.requests.length, count, 'and so does a restart');
  await again.advance(61 * MINUTE);
  assert.ok(server.requests.length > count);
});

test('code buttons during a verification: refusals, a renewed waiting token, 429 and 403', async (t) => {
  const server = fakePicnic({ twoFactor: true });
  const store = memoryStore();
  const { gladys, advance } = await setup(t, { server, store });
  server.queue.push({
    match: is(GENERATE),
    status: 400,
    body: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Try later' } },
  });
  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /refused to send the code \(TOO_MANY_ATTEMPTS\)/);
  assert.match(ack.data.message.fr, /Envoi du code refusé par Picnic \(TOO_MANY_ATTEMPTS\)/);

  await advance(MINUTE);
  const renewed = server.issue(server.preAuth);
  server.queue.push({
    match: is(GENERATE),
    status: 204,
    body: undefined,
    headers: { 'x-picnic-auth': renewed },
  });
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /by SMS/);
  assert.equal(store.data.pending.token, renewed, 'the new waiting token is kept');

  server.queue.push({
    match: is(VERIFY),
    status: 429,
    body: '',
    headers: { 'retry-after': '120' },
  });
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /slow down/);
  assert.match(message(gladys).en, /asks for a verification code.*slow down/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /slow down/);
  assert.equal(server.of(VERIFY).length, 1, 'paused: no request');
  await advance(3 * MINUTE);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /Code accepted/);
  assert.equal(server.of(VERIFY).at(-1).token, renewed);
});

test('a 403 on a code button pauses every path for an hour', async (t) => {
  const server = fakePicnic({ twoFactor: true });
  const { gladys, advance } = await setup(t, { server });
  server.queue.push({ match: is(GENERATE), status: 403, body: '<html>blocked</html>' });
  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /HTTP 403.*60 min/);
  assert.match(message(gladys).en, /asks for a verification code.*HTTP 403/);
  await advance(2 * MINUTE);
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /HTTP 403/);
  assert.equal(server.of(GENERATE).length, 1);
});

test('a restart between the two steps: the code still verifies, the one-a-minute limit holds', async (t) => {
  const server = fakePicnic({ twoFactor: true });
  const store = memoryStore();
  const first = await setup(t, { server, store });
  await first.gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.equal(server.of(GENERATE).length, 1);
  first.app.stop();
  t.mock.timers.reset();

  const { gladys } = await setup(t, { server, store, now: NOW + 30_000 });
  assert.equal(server.logins().length, 1, 'no new sign-in at the restart');
  assert.match(message(gladys).en, /asks for a verification code/);
  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  assert.match(ack.data.message.en, /less than a minute ago/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /Code accepted/);
  assert.equal(server.reads().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('no e-mail, password, password hash, token or code ever reaches the logs', async (t) => {
  const logs = [];
  const server = fakePicnic({ twoFactor: true });
  const { gladys, advance } = await setup(t, { server, logs });
  await gladys.fake.action(ACTIONS.REQUEST_CODE, { channel: 'sms' });
  await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: '000000' });
  await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  server.revoke();
  server.secret = 'something else';
  await advance(15 * MINUTE);
  assert.match(message(gladys).en, /refused the e-mail/);
  assert.ok(logs.length >= 4, 'the flow was logged');
  const text = logs.join('\n');
  const secrets = [
    EMAIL,
    PASSWORD,
    createHash('md5').update(PASSWORD, 'utf8').digest('hex'),
    CODE,
    '000000',
    ...server.all,
  ];
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a secret reached the logs: ${secret.slice(0, 6)}…`);
  }
});
