// -----------------------------------------------------------------------------
// The Picnic account: the sign-in (e-mail, MD5 of the password, country), the
// two-step verification when Picnic asks for it, the session token kept and
// renewed from the `x-picnic-auth` header, and the three reads the
// integration needs. Every request goes through the transport of
// src/picnic.js. Ported from python-picnic-api2 (Apache-2.0).
// -----------------------------------------------------------------------------

import { CODE_CHANNELS, HEADERS, PATHS, TIMINGS, baseUrlOf } from './constants.js';
import {
  PicnicError,
  errorCode,
  errorFor,
  httpRequest,
  parseJson,
  passwordSecret,
  tokenExpiry,
} from './picnic.js';

export class PicnicClient {
  constructor({ transport = httpRequest, now = Date.now, onChange } = {}) {
    this.transport = transport;
    this.now = now;
    /** Called after the session or the pending sign-in changed (persist them; never throws). */
    this.onChange = onChange;
    this.email = '';
    this.password = '';
    this.country = '';
    /** `x-picnic-did`: a device id made once per installation (see src/store.js). */
    this.did = '';
    /** { token, expiresAt } | null */
    this.session = null;
    /** A sign-in waiting for its verification code: { token, at } | null */
    this.pending = null;
    this.signingIn = undefined;
    /** One new sign-in per cycle at most (beginCycle resets it). */
    this.relogged = false;
  }

  configure({ email, password, country, did, session = null, pending = null }) {
    this.email = email;
    this.password = password;
    this.country = country;
    this.did = did;
    this.session = session?.token ? session : null;
    this.pending = pending?.token ? pending : null;
    this.relogged = false;
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '' && this.country !== '';
  }

  get baseUrl() {
    return baseUrlOf(this.country);
  }

  beginCycle() {
    this.relogged = false;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the session still works in memory.
    }
  }

  headers(token, body, picnic) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': HEADERS.userAgent,
      'Content-Type': 'application/json; charset=UTF-8',
    };
    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) {
      headers[HEADERS.auth] = token;
    }
    if (picnic) {
      headers['x-picnic-agent'] = HEADERS.agent;
      headers['x-picnic-did'] = this.did;
    }
    return headers;
  }

  /** One request; resolves `{ json, token }`, `token` being a new `x-picnic-auth` header. */
  async send(method, path, { payload, token, picnic = false, login = false } = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const answer = await this.transport(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(token, body, picnic),
      body,
    });
    let json;
    try {
      json = parseJson(answer.body);
    } catch (err) {
      if (answer.status >= 200 && answer.status < 300) {
        throw err;
      }
    }
    const error = errorFor(answer, json, { login, now: this.now() });
    if (error) {
      throw error;
    }
    const header = answer.headers?.[HEADERS.auth];
    return { json, token: typeof header === 'string' && header !== '' ? header : undefined };
  }

  /** Signs in; one sign-in at a time. Rejects `two_factor` when Picnic asks for a code. */
  login() {
    if (!this.hasCredentials) {
      return Promise.reject(new PicnicError('no_credentials', 'no e-mail, password or country'));
    }
    if (!this.signingIn) {
      const { email, country } = this;
      this.signingIn = this.send('POST', PATHS.login, {
        payload: { key: email, secret: passwordSecret(this.password), client_id: HEADERS.clientId },
        picnic: true,
        login: true,
      })
        .then(async ({ json, token }) => {
          if (this.email !== email || this.country !== country) {
            throw new PicnicError('network', 'the account changed during the sign-in');
          }
          if (!token) {
            throw new PicnicError('bad_response', 'Picnic sent no session token');
          }
          if (json?.second_factor_authentication_required === true) {
            this.session = null;
            this.pending = { token, at: this.now() };
            await this.changed();
            throw new PicnicError('two_factor', 'Picnic asks for a verification code');
          }
          this.session = { token, expiresAt: tokenExpiry(token) };
          this.pending = null;
          await this.changed();
          return this.session;
        })
        .finally(() => {
          this.signingIn = undefined;
        });
    }
    return this.signingIn;
  }

  /** A request with the session token; a new token in the answer replaces it. */
  async request(method, path, options) {
    const token = this.session.token;
    const { json, token: renewed } = await this.send(method, path, { ...options, token });
    if (renewed && this.session?.token === token && renewed !== token) {
      this.session = { token: renewed, expiresAt: tokenExpiry(renewed) };
      await this.changed();
    }
    return json;
  }

  /**
   * An authenticated call. A refused token signs in again once, then retries
   * once; refused again (or refused right after a fresh sign-in) it is
   * `session_refused` and the caller stops.
   */
  async call(method, path, options = {}) {
    let fresh = false;
    if (!this.session) {
      if (this.relogged) {
        throw new PicnicError('session_refused', 'the session was refused after a new sign-in');
      }
      this.relogged = true;
      await this.login();
      fresh = true;
    }
    const token = this.session.token;
    try {
      return await this.request(method, path, options);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      if (this.session?.token === token) {
        this.session = null;
        await this.changed();
      }
      if (fresh || this.relogged) {
        throw new PicnicError('session_refused', 'the session was refused after a new sign-in', {
          status: err.status,
          code: err.code,
        });
      }
    }
    this.relogged = true;
    if (!this.session) {
      await this.login();
    }
    try {
      return await this.request(method, path, options);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      this.session = null;
      await this.changed();
      throw new PicnicError('session_refused', 'the session was refused after a new sign-in', {
        status: err.status,
        code: err.code,
      });
    }
  }

  /** The cart: its count, its total (cents), the slots offered and the selected one. */
  async cart() {
    const data = await this.call('GET', PATHS.cart, { picnic: true });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new PicnicError('bad_response', 'Picnic sent no cart');
    }
    return data;
  }

  /** Every delivery, the most recent first (POST /deliveries/summary with `[]`). */
  async deliveries() {
    const data = await this.call('POST', PATHS.deliveries, { payload: [] });
    if (!Array.isArray(data)) {
      throw new PicnicError('bad_response', 'Picnic sent no delivery list');
    }
    return data;
  }

  /** The live position of a delivery on its way (empty outside that window). */
  async position(deliveryId) {
    const data = await this.call('GET', PATHS.position(deliveryId), { picnic: true });
    return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
  }

  // --- Two-step verification -------------------------------------------------

  get pendingFresh() {
    return Boolean(this.pending) && this.now() - this.pending.at < TIMINGS.pendingLifetime;
  }

  /** A 2FA call with the token of the pending sign-in; an error code is a refusal. */
  async twoFactor(path, payload) {
    let answer;
    try {
      answer = await this.send('POST', path, { payload, token: this.pending.token, picnic: true });
    } catch (err) {
      if (err.kind === 'unauthorized') {
        this.pending = null;
        await this.changed();
        throw new PicnicError('code_expired', 'the sign-in waiting for its code expired', {
          status: err.status,
          code: err.code,
        });
      }
      if (err.kind === 'http' && err.code) {
        throw new PicnicError('code_refused', 'Picnic refused the code', {
          status: err.status,
          code: err.code,
        });
      }
      throw err;
    }
    const code = errorCode(answer.json);
    if (code) {
      throw new PicnicError('code_refused', 'Picnic refused the code', { code });
    }
    return answer;
  }

  /**
   * Asks Picnic to send a verification code ("sms" or "email"). Signs in first
   * when no sign-in is waiting; resolves "not_needed" when it needs no code.
   */
  async requestCode(channel) {
    const value = CODE_CHANNELS[channel];
    if (!value) {
      throw new PicnicError('code_refused', `unknown channel ${String(channel).slice(0, 10)}`);
    }
    if (!this.pendingFresh) {
      try {
        await this.login();
        return 'not_needed';
      } catch (err) {
        if (err.kind !== 'two_factor') {
          throw err;
        }
      }
    }
    await this.twoFactor(PATHS.generateCode, { channel: value });
    return 'sent';
  }

  /** Checks the code; the waiting sign-in becomes the session. */
  async verifyCode(code) {
    if (!this.pending) {
      throw new PicnicError('no_pending', 'no sign-in is waiting for a code');
    }
    const { token } = await this.twoFactor(PATHS.verifyCode, { otp: code });
    const session = token ?? this.pending.token;
    this.session = { token: session, expiresAt: tokenExpiry(session) };
    this.pending = null;
    this.relogged = false;
    await this.changed();
    return this.session;
  }
}
