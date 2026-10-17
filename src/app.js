// -----------------------------------------------------------------------------
// The integration: the Picnic account (e-mail, password, country, and the
// verification code when Picnic asks for one), one read of the cart and of
// the deliveries per cycle (plus the live position around a delivery), the
// Gladys device and its states, the "delivery approaching" scene event, the
// transport badge and the configuration buttons. Read only: nothing is ever
// added to the cart or ordered. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { PicnicClient } from './client.js';
import { normalizeConfig } from './config.js';
import { CODE_CHANNELS, LIMITS, MINUTE, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { accountIds, buildDevice, deviceKeyOf, deviceStates, statusName } from './devices.js';
import { T, age, join } from './i18n.js';
import {
  approaching,
  isNear,
  nextDelay,
  offsetFor,
  readNextDelivery,
  readSnapshot,
  wallClock,
} from './model.js';
import { errorReason } from './picnic.js';
import { StatePublisher } from './publisher.js';
import { fileStore, newDeviceId, normalizeMemory } from './store.js';

/** Errors Picnic did not answer usefully for: the account is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);
/** Errors that stop the polling until the user acts (configuration, buttons). */
const BLOCKED = {
  refused: 'refused',
  no_credentials: 'refused',
  login_rejected: 'login_rejected',
  two_factor: 'two_factor',
};
/** Errors of the main reads the position read passes on (the rest is logged). */
const FATAL = new Set(['refused', 'login_rejected', 'two_factor', 'session_refused']);

export class PicnicApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'picnic' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    randomDid = newDeviceId,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.randomDid = randomDid;
    this.client = new PicnicClient({ transport, now, onChange: () => this.persist() });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** The last read (readSnapshot), undefined before the first one. */
    this.snapshot = undefined;
    this.readAt = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    /**
     * undefined | 'refused' | 'login_rejected' | 'two_factor': waits for the
     * user; 'session_refused': tried again after 1 h, 6 h, then every 24 h.
     */
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (a 429: every path waits), 'forbidden' (every path too) or 'backoff'. */
    this.pauseKind = undefined;
    this.lastTestAt = -Infinity;
    this.started = false;
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.memory = normalizeMemory(await this.store.load().catch(() => null));
    if (!this.memory.did) {
      this.memory.did = this.randomDid();
      await this.saveMemory();
    }
    // A 429 pause survives a restart and a change of account.
    if (this.memory.rateLimitedUntil > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = this.memory.rateLimitedUntil;
      this.pauseKind = 'rate';
    }
    const { email, password, country, account } = this.config;
    const mine = (entry) => (entry && entry.account === account ? entry : null);
    this.client.configure({
      email,
      password,
      country,
      did: this.memory.did,
      session: mine(this.memory.session),
      pending: mine(this.memory.pending),
    });
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (!this.client.session && this.client.pending) {
      // Restarted between "Send the code" and "Verify the code".
      this.blocked = 'two_factor';
      await this.setStatus(false, T.twoFactor);
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the account and the failures: a new account, or a restart. A 429 pause stays. */
  reset() {
    this.snapshot = undefined;
    this.readAt = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (Discovery list,
   * status, badge). The pauses, the blocks and the session stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badge = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevice();
    await this.publishBadge();
  }

  /** A new account restarts; a new interval reschedules; a new language renames. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (
      next.email !== previous.email ||
      next.password !== previous.password ||
      next.country !== previous.country
    ) {
      return this.start(raw);
    }
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      await this.publishDevice();
      this.queueStates();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The session and the waiting sign-in of the client, with their account. */
  async persist() {
    const { account } = this.config;
    const { session, pending } = this.client;
    this.memory.session = session ? { account, ...session } : null;
    this.memory.pending = pending ? { account, ...pending } : null;
    await this.saveMemory();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  /** The next read: after the pause, else the interval (shorter around a delivery). */
  scheduleNext() {
    this.clearTimer();
    if (!this.client.hasCredentials) {
      return;
    }
    const now = this.now();
    let delay;
    if (this.blocked === 'session_refused') {
      delay = Math.max(this.retryAt, this.pausedUntil) - now;
    } else if (this.blocked) {
      return;
    } else if (now < this.pausedUntil) {
      delay = this.pausedUntil - now;
    } else {
      delay = nextDelay(this.snapshot?.next, now, this.config.pollInterval * MINUTE);
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Picnic refresh failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for a button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    if (!this.client.hasCredentials) {
      return;
    }
    if (this.blocked === 'session_refused' && now >= this.retryAt) {
      // The spaced new try: one sign-in, never a code.
      this.logger.info('Picnic: trying the session again');
      this.blocked = undefined;
    }
    if (this.blocked) {
      this.scheduleNext();
      return;
    }
    if (now < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    try {
      const cart = await this.client.cart();
      const deliveries = await this.client.deliveries();
      const next = readNextDelivery(deliveries, this.now());
      let position;
      let secondary;
      if (!quick && next && isNear(next, this.now())) {
        // A secondary read: its failure never hides the cart and the deliveries,
        // and a refused token there never stops anything (the next cart read tells).
        try {
          position = await this.client.position(next.id);
        } catch (err) {
          if (FATAL.has(err.kind)) {
            throw err;
          }
          // Only a 429 pauses every path; a 403 here (a CDN on this endpoint) is
          // logged like the others: the next cart read tells a real block.
          if (err.kind === 'rate_limited') {
            secondary = err;
          }
          this.logger.info(`Picnic position not read: ${errorReason(err)}`);
        }
      }
      if (generation !== this.generation) {
        return;
      }
      await this.apply(readSnapshot({ cart, deliveries, position }, this.now()));
      this.failures = 0;
      this.sessionRetries = 0;
      this.offline = false;
      this.connectedOnce = true;
      this.pauseKind = undefined;
      await this.setStatus(true, T.connected(this.snapshot.next?.start?.text));
      if (secondary) {
        await this.failed(secondary);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadge();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  async failed(err) {
    const reason = errorReason(err);
    const blocked = BLOCKED[err.kind];
    if (blocked) {
      // Never signed in again by itself: refusals may lock the account, and a
      // new sign-in asking for a code needs the user anyway.
      this.blocked = blocked;
      this.logger.warn(`Picnic stopped: ${reason}`);
      const message =
        blocked === 'refused'
          ? T.refused
          : blocked === 'login_rejected'
            ? T.loginRejected(err.status)
            : T.twoFactor;
      await this.setStatus(false, message);
      return;
    }
    if (err.kind === 'session_refused') {
      // Spaced new tries (1 h, 6 h, then every 24 h), one sign-in each.
      const wait =
        TIMINGS.sessionRetry[Math.min(this.sessionRetries, TIMINGS.sessionRetry.length - 1)];
      this.sessionRetries += 1;
      this.blocked = 'session_refused';
      this.retryAt = this.now() + wait;
      this.logger.warn(`Picnic: ${reason}; one new try in ${Math.round(wait / 60_000)} min`);
      await this.setStatus(false, T.sessionRefused(age(wait)));
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
      message = T.rateLimited(age(wait));
    } else if (err.kind === 'forbidden') {
      wait = TIMINGS.forbiddenPause;
      this.pauseKind = 'forbidden';
      this.offline = true;
      message = T.forbidden(age(wait));
    } else {
      wait = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
      this.pauseKind = 'backoff';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      message = T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    if (this.pauseKind === 'rate') {
      this.memory.rateLimitedUntil = this.pausedUntil;
      await this.saveMemory();
    }
    // While a code is awaited, the status keeps saying so.
    const connected = err.kind === 'rate_limited' && this.connectedOnce && !this.blocked;
    await this.setStatus(
      connected,
      this.blocked === 'two_factor' ? join(T.twoFactor, message) : message,
    );
    this.logger.warn(`Picnic: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  async apply(snapshot) {
    this.snapshot = snapshot;
    this.readAt = this.now();
    await this.publishDevice();
    this.queueStates();
    await this.announce();
  }

  // --- Gladys ----------------------------------------------------------------

  /**
   * The device key of the account, chosen once and kept in /data: the Picnic
   * user id of the sign-in, else the country and a hash of the e-mail.
   */
  get deviceKey() {
    const { account } = this.config;
    if (!account) {
      return undefined;
    }
    if (this.memory.deviceKey?.account === account) {
      return this.memory.deviceKey.key;
    }
    return deviceKeyOf(account, this.client.session?.userId);
  }

  get ids() {
    return accountIds(this.gladys, this.deviceKey);
  }

  async publishDevice() {
    const key = this.deviceKey;
    if (!this.snapshot || !key) {
      return;
    }
    if (this.memory.deviceKey?.account !== this.config.account) {
      this.memory.deviceKey = { account: this.config.account, key };
      await this.saveMemory();
    }
    const device = buildDevice(this.gladys, key, this.config);
    const json = JSON.stringify(device);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered device failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    if (!this.snapshot || !this.deviceKey) {
      return;
    }
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      this.ids,
      this.snapshot,
      this.config.language,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** "Delivery approaching": once per delivery, when its ETA is close enough. */
  async announce() {
    const { next } = this.snapshot;
    const close = approaching(next, this.now(), this.config.approachMinutes * MINUTE);
    if (!close || this.memory.announced.includes(next.id)) {
      return;
    }
    this.memory.announced = [...this.memory.announced, next.id].slice(-LIMITS.announced);
    await this.saveMemory();
    const eta = wallClock(next.arrival, offsetFor(next));
    this.logger.info(`Picnic delivery approaching: ${close.minutes} min`);
    this.publisher.pushSceneEvent(SCENE_TRIGGERS.DELIVERY_APPROACHING, {
      minutes: close.minutes,
      eta,
      slot_start: next.start.text,
      slot_end: next.end?.text ?? '',
    });
  }

  async publishBadge() {
    if (!this.deviceKey) {
      return;
    }
    const externalId = this.ids.device;
    if (!(this.gladys.devices ?? []).some((d) => d.external_id === externalId)) {
      return;
    }
    const transport =
      this.blocked || this.offline ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
    const entry = { external_id: externalId, transport };
    const json = JSON.stringify(entry);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports([entry]);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read (no extra request). */
  async scan() {
    await this.publishDevice();
  }

  // --- Configuration buttons ----------------------------------------------------

  /** A 429 or 403 pause holds for every path, buttons included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'forbidden' ? T.forbidden(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'two_factor') {
      return T.twoFactor;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    // At most one sign-in per 30 s from this button, whatever happened before.
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.snapshot && !this.blocked ? this.summary() : this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    // One sign-in per click: the button is how a stopped account is retried.
    this.blocked = undefined;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    await this.tick({ quick: true });
    const [connected, message] = JSON.parse(this.lastStatus ?? '[false,null]');
    if (!connected || !this.snapshot) {
      return message ?? T.noCredentials;
    }
    return this.summary();
  }

  summary() {
    const { next, lastOrder, cart } = this.snapshot;
    const status = lastOrder?.status
      ? { en: statusName(lastOrder.status, 'en'), fr: statusName(lastOrder.status, 'fr') }
      : undefined;
    return T.test.summary({
      next: next?.start?.text,
      status,
      count: cart.count,
      total: cart.total?.toFixed(2),
    });
  }

  /** An error of the code buttons -> the message under the button. */
  async codeFailure(err) {
    switch (err.kind) {
      case 'refused':
      case 'no_credentials':
        await this.failed(err);
        return T.refused;
      case 'login_rejected':
        await this.failed(err);
        return T.loginRejected(err.status);
      case 'code_refused':
        return T.code.refused;
      case 'code_send_refused':
        return T.code.sendRefused(err.code);
      case 'code_expired':
        await this.setStatus(false, T.twoFactor);
        return T.code.expired;
      case 'no_pending':
        return T.code.noPending;
      case 'rate_limited':
      case 'forbidden':
        await this.failed(err);
        return this.pauseMessage();
      default:
        this.logger.warn(`Picnic verification: ${errorReason(err)}`);
        return T.code.failed(errorReason(err));
    }
  }

  /** Step 1: sign in, and have Picnic send a code by SMS or e-mail. */
  async requestCode(fields) {
    const channel = String(fields?.channel ?? '').toLowerCase();
    if (!fields || typeof fields !== 'object' || !CODE_CHANNELS[channel]) {
      return T.code.needsFields;
    }
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.client.session && !this.blocked) {
      // Connected: a new sign-in would only risk the working session.
      return T.code.alreadyConnected;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    const lastCodeAt = this.memory.codeAt ?? -Infinity;
    if (this.now() - lastCodeAt < TIMINGS.codeCooldown) {
      return T.code.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.memory.codeAt = this.now();
    await this.saveMemory();
    this.client.timeout = TIMINGS.quickTimeout;
    let result;
    try {
      result = await this.client.requestCode(channel);
    } catch (err) {
      return this.codeFailure(err);
    } finally {
      this.client.timeout = undefined;
    }
    if (result === 'not_needed') {
      this.blocked = undefined;
      this.pausedUntil = 0;
      await this.tick({ quick: true });
      return T.code.notNeeded;
    }
    this.blocked = 'two_factor';
    this.clearTimer();
    await this.setStatus(false, T.twoFactor);
    this.logger.info(`Picnic verification code requested (${channel})`);
    return T.code.sent(channel);
  }

  /** Step 2: the code received; the waiting sign-in becomes the session. */
  async verifyCode(fields) {
    if (!fields || typeof fields !== 'object' || !('code' in fields)) {
      return T.code.needsFields;
    }
    const code = String(fields.code ?? '').replace(/[\s-]/g, '');
    if (!/^\d{4,10}$/.test(code)) {
      return T.code.badFormat;
    }
    if (!this.client.pending) {
      return T.code.noPending;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.running) {
      return T.busy;
    }
    this.client.timeout = TIMINGS.quickTimeout;
    try {
      await this.client.verifyCode(code);
    } catch (err) {
      return this.codeFailure(err);
    } finally {
      this.client.timeout = undefined;
    }
    this.logger.info('Picnic verification code accepted');
    this.blocked = undefined;
    this.failures = 0;
    this.pausedUntil = 0;
    await this.tick({ quick: true });
    return T.code.verified;
  }
}
