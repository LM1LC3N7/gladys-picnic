// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to the Picnic storefront API, and
// the errors they end with. Pure helpers for the password hash, the token
// expiry and the answers.
//
// python-picnic-api2 (Apache-2.0) is the reference: the password is sent as
// its MD5 hex digest, the session token comes back in the `x-picnic-auth`
// header, and an authentication failure is a JSON `error.code` of
// `AUTH_ERROR` or `AUTH_INVALID_CRED`, whatever the HTTP status.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed Picnic call. `kind`:
 * - `no_credentials`: no e-mail, password or country (never sent);
 * - `refused`: the sign-in was refused (e-mail or password);
 * - `two_factor`: the sign-in needs a verification code (SMS or e-mail);
 * - `login_rejected`: the sign-in request itself was rejected (400/422: the
 *   API changed, the integration needs an update);
 * - `code_refused`: Picnic refused the verification code;
 * - `code_send_refused`: Picnic refused to send a code (channel, account);
 * - `code_expired`, `no_pending`: no sign-in (still) waiting for a code;
 * - `unauthorized`: the API refused the session token;
 * - `session_refused`: the token was refused again right after a new sign-in;
 * - `forbidden`: a 403 that is not an authentication error (a CDN block);
 * - `rate_limited`: 429, `retryAfter` in ms when given;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer;
 * - `bad_response`, `size`: an answer that is not the expected JSON;
 * - `http`: any other status.
 * The message never holds a secret (no password, token or code).
 */
export class PicnicError extends Error {
  constructor(kind, message, { status, retryAfter, code } = {}) {
    super(message);
    this.name = 'PicnicError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> PicnicError (never the request: the sign-in carries the password hash). */
export function networkError(err) {
  if (err instanceof PicnicError) {
    return err;
  }
  return new PicnicError('network', NETWORK_REASONS[err?.code] ?? err?.code ?? 'network error');
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof PicnicError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return String(err?.message ?? err);
}

/** The `secret` python-picnic-api2 sends: the MD5 hex digest of the UTF-8 password. */
export const passwordSecret = (password) =>
  createHash('md5').update(String(password), 'utf8').digest('hex');

/**
 * One request; resolves `{ status, headers, body }` whatever the status. The
 * promise settles once; the body read is bounded.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new PicnicError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new PicnicError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body (204, an empty position). */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new PicnicError('bad_response', 'Picnic sent an answer that is not JSON');
  }
}

/** The `error.code` of an answer, a short identifier only (never its free text). */
export function errorCode(json) {
  const code = json && typeof json === 'object' && !Array.isArray(json) ? json.error?.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

export const isAuthCode = (code) => code === 'AUTH_ERROR' || code === 'AUTH_INVALID_CRED';

/**
 * The error of an answer, or undefined when it is a success. `login`: the
 * answer of the sign-in, where a refusal means the e-mail or the password.
 */
export function errorFor({ status, headers = {} }, json, { login = false, now } = {}) {
  const code = errorCode(json);
  if (isAuthCode(code) || status === 401) {
    return login
      ? new PicnicError('refused', 'e-mail or password refused', { status, code })
      : new PicnicError('unauthorized', 'session refused', { status, code });
  }
  if (status === 429) {
    return new PicnicError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new PicnicError('unavailable', 'Picnic is unavailable', { status });
  }
  if (status === 403) {
    return new PicnicError('forbidden', 'request refused', { status, code });
  }
  if (login && (status === 400 || status === 422)) {
    // The request itself is refused (an API change): stop like a refusal, never in a loop.
    return new PicnicError('login_rejected', 'sign-in request rejected', { status, code });
  }
  if (status < 200 || status >= 300) {
    return new PicnicError('http', 'request failed', { status, code });
  }
  return undefined;
}

/** The expiry (ms since the epoch) of a JWT, from its `exp` claim; undefined otherwise. */
export function tokenExpiry(token) {
  const payload = String(token ?? '').split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = Number(claims?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
