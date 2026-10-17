// -----------------------------------------------------------------------------
// A fake Picnic storefront behind the transport the integration is given: the
// sign-in (with or without a verification code), the two 2FA calls, the
// cart, the delivery summary and the position, answering like
// python-picnic-api2 expects (token in `x-picnic-auth`, `error.code` on a
// refusal). Records every request. No network.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { PicnicError } from '../../src/picnic.js';
import { CODE, DAY, EMAIL, PASSWORD, cart, deliveries, jwt } from '../fixtures/picnic.js';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

export function fakePicnic({ twoFactor = false, lifetime = 30 * DAY } = {}) {
  const server = {
    email: EMAIL,
    secret: md5(PASSWORD),
    twoFactor,
    code: CODE,
    lifetime,
    cart: cart(),
    deliveries: deliveries(),
    /** The position answer: an object, or '' (empty, as outside the delivery window). */
    position: '',
    /** { method, host, path, body, token, headers } */
    requests: [],
    tokens: new Set(),
    preAuth: new Set(),
    issued: 0,
    /** Every token ever issued, to check none reaches the logs. */
    all: [],
    down: false,
    /** Every read refuses the token (a session the server never accepts). */
    rejectData: false,
    /** One-shot answers: { match(request), status, body, headers } */
    queue: [],
    of(path) {
      return this.requests.filter((r) => r.path === path);
    },
    logins() {
      return this.of('/user/login');
    },
    reads() {
      return this.of('/cart');
    },
    issue(set = this.tokens) {
      this.issued += 1;
      const token = jwt({
        sub: 'user-1',
        n: this.issued,
        exp: Math.floor((Date.now() + this.lifetime) / 1000),
      });
      set.add(token);
      this.all.push(token);
      return token;
    },
    /** Refuse every token issued so far (expired or revoked on the server side). */
    revoke() {
      this.tokens.clear();
    },
  };

  server.transport = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const target = new URL(url);
    const path = target.pathname.replace(/^\/api\/15/, '');
    const request = {
      method,
      host: target.host,
      path,
      body: body === undefined ? undefined : JSON.parse(body),
      token: headers['x-picnic-auth'],
      headers,
    };
    server.requests.push(request);
    if (server.down) {
      throw new PicnicError('network', 'connection refused');
    }
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [{ status, body: forcedBody, headers: forcedHeaders }] = server.queue.splice(forced, 1);
      return answer(status, forcedBody, forcedHeaders);
    }

    if (path === '/user/login' && method === 'POST') {
      const { key, secret, client_id: clientId } = request.body ?? {};
      if (key !== server.email || secret !== server.secret || clientId !== 30100) {
        return answer(401, {
          error: { code: 'AUTH_INVALID_CRED', message: 'Invalid credentials' },
        });
      }
      if (server.twoFactor) {
        const token = server.issue(server.preAuth);
        return answer(
          200,
          { user_id: 'user-1', second_factor_authentication_required: true },
          { 'x-picnic-auth': token },
        );
      }
      return answer(
        200,
        { user_id: 'user-1', second_factor_authentication_required: false },
        { 'x-picnic-auth': server.issue() },
      );
    }
    if (path === '/user/2fa/generate' || path === '/user/2fa/verify') {
      if (!server.preAuth.has(request.token)) {
        return answer(401, { error: { code: 'AUTH_ERROR', message: 'Not authenticated' } });
      }
      if (path === '/user/2fa/generate') {
        return ['SMS', 'EMAIL'].includes(request.body?.channel)
          ? answer(204)
          : answer(400, { error: { code: 'INVALID_CHANNEL', message: 'Invalid channel' } });
      }
      if (request.body?.otp !== server.code) {
        return answer(400, { error: { code: 'OTP_INVALID', message: 'Invalid code' } });
      }
      server.preAuth.delete(request.token);
      return answer(204, undefined, { 'x-picnic-auth': server.issue() });
    }

    if (!server.tokens.has(request.token) || server.rejectData) {
      return answer(401, { error: { code: 'AUTH_ERROR', message: 'Not authenticated' } });
    }
    if (path === '/cart' && method === 'GET') {
      return answer(200, server.cart);
    }
    if (path === '/deliveries/summary' && method === 'POST') {
      return answer(200, server.deliveries);
    }
    if (/^\/deliveries\/[^/]+\/position$/.test(path) && method === 'GET') {
      return answer(200, server.position);
    }
    return answer(404, { error: { code: 'NOT_FOUND' } });
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
