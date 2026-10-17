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
import { accountIds, buildDevice, deviceStates, statusName } from './devices.js';
import { T, age } from './i18n.js';
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
const BLOCKED = { refused: 'refused', no_credentials: 'refused', two_factor: 'two_factor' };

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
    /** undefined | 'refused' | 'two_factor' | 'session_refused': waits for the user. */
    this.blocked = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (a 429: every path waits), 'forbidden' or 'backoff'. */
    this.pauseKind = undefined;
    this.lastTestAt = -Infinity;
    this.lastCodeAt = -Infinity;
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
    await this.setStatus(false, T.connecting);
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

  /** Forgets the account and the failures: a new account, or a restart. */
  reset() {
    this.snapshot = undefined;
    this.readAt = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.blocked = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
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
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const now = this.now();
    const delay =
      now < this.pausedUntil
        ? this.pausedUntil - now
        : nextDelay(this.snapshot?.next, now, this.config.pollInterval * MINUTE);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch((err) => this.logger.error(`Picnic refresh failed: ${err.message}`));
      }
    }, delay);
  }

  /** One run at a time: a tick during a run joins it. */
  tick() {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run() {
    const generation = this.generation;
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    if (this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    try {
      const cart = await this.client.cart();
      const deliveries = await this.client.deliveries();
      const next = readNextDelivery(deliveries);
      let position;
      let secondary;
      if (next && isNear(next, this.now())) {
        // A secondary read: its failure never hides the cart and the deliveries.
        try {
          position = await this.client.position(next.id);
        } catch (err) {
          if (['refused', 'two_factor', 'session_refused'].includes(err.kind)) {
            throw err;
          }
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
    }
    await this.publishBadge();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  async failed(err) {
    const reason = errorReason(err);
    const blocked = BLOCKED[err.kind] ?? (err.kind === 'session_refused' ? err.kind : undefined);
    if (blocked) {
      // Never signed in again by itself: refusals may lock the account, and a
      // new sign-in asking for a code needs the user anyway.
      this.blocked = blocked;
      this.logger.warn(`Picnic stopped: ${reason}`);
      const message = { refused: T.refused, two_factor: T.twoFactor }[blocked] ?? T.sessionRefused;
      await this.setStatus(false, message);
      return;
    }
    let wait;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
      await this.setStatus(this.connectedOnce, T.rateLimited(age(wait)));
    } else if (err.kind === 'forbidden') {
      wait = TIMINGS.forbiddenPause;
      this.pauseKind = 'forbidden';
      this.offline = true;
      await this.setStatus(false, T.forbidden(age(wait)));
    } else {
      wait = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
      this.pauseKind = 'backoff';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      await this.setStatus(false, T.unreachable(reason, age(wait)));
    }
    this.failures += 1;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
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

  get ids() {
    return accountIds(this.gladys, this.config.account);
  }

  async publishDevice() {
    if (!this.snapshot || !this.config.account) {
      return;
    }
    const device = buildDevice(this.gladys, this.config.account, this.config);
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
    if (!this.snapshot) {
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
    if (!this.config.account) {
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

  /** The 429 pause holds for every path, buttons included. */
  rateLimitedMessage() {
    const left = this.pausedUntil - this.now();
    return this.pauseKind === 'rate' && left > 0 ? T.rateLimited(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'two_factor') {
      return T.twoFactor;
    }
    const limited = this.rateLimitedMessage();
    if (limited) {
      return limited;
    }
    if (this.snapshot && this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const summary = this.summary();
      return {
        en: `${T.test.cooldown.en} ${summary.en}`,
        fr: `${T.test.cooldown.fr} ${summary.fr}`,
      };
    }
    this.lastTestAt = this.now();
    // One sign-in per click: the button is how a stopped account is retried.
    this.blocked = undefined;
    this.pausedUntil = 0;
    await this.running;
    await this.tick();
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
      case 'code_refused':
        return T.code.refused;
      case 'code_expired':
        await this.setStatus(false, T.twoFactor);
        return T.code.expired;
      case 'no_pending':
        return T.code.noPending;
      case 'rate_limited':
        await this.failed(err);
        return this.rateLimitedMessage();
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
    const limited = this.rateLimitedMessage();
    if (limited) {
      return limited;
    }
    if (this.now() - this.lastCodeAt < TIMINGS.codeCooldown) {
      return T.code.cooldown;
    }
    this.lastCodeAt = this.now();
    await this.running;
    try {
      const result = await this.client.requestCode(channel);
      if (result === 'not_needed') {
        this.blocked = undefined;
        this.pausedUntil = 0;
        await this.tick();
        return T.code.notNeeded;
      }
      this.blocked = 'two_factor';
      this.clearTimer();
      await this.setStatus(false, T.twoFactor);
      this.logger.info(`Picnic verification code requested (${channel})`);
      return T.code.sent(channel);
    } catch (err) {
      return this.codeFailure(err);
    }
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
    const limited = this.rateLimitedMessage();
    if (limited) {
      return limited;
    }
    await this.running;
    try {
      await this.client.verifyCode(code);
    } catch (err) {
      return this.codeFailure(err);
    }
    this.logger.info('Picnic verification code accepted');
    this.blocked = undefined;
    this.failures = 0;
    this.pausedUntil = 0;
    await this.tick();
    return T.code.verified;
  }
}
