// -----------------------------------------------------------------------------
// src/picnic.js: the errors, the password hash, the token expiry, and the
// real transport against a loopback server (no Internet).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  PicnicError,
  errorFor,
  errorReason,
  httpRequest,
  parseJson,
  parseRetryAfter,
  passwordSecret,
  tokenExpiry,
} from '../src/picnic.js';
import { baseUrlOf } from '../src/constants.js';
import { jwt } from './fixtures/picnic.js';

test('one storefront per country, API 15', () => {
  assert.equal(baseUrlOf('NL'), 'https://storefront-prod.nl.picnicinternational.com/api/15');
  assert.equal(baseUrlOf('FR'), 'https://storefront-prod.fr.picnicinternational.com/api/15');
});

test('the password is sent as its MD5 hex digest, like python-picnic-api2', () => {
  assert.equal(passwordSecret('password'), '5f4dcc3b5aa765d61d8327deb882cf99');
  assert.equal(passwordSecret('pässword').length, 32);
});

test('errors: authentication codes whatever the status, 429, 5xx, 403', () => {
  const kind = (answer, json, options) => errorFor(answer, json, options)?.kind;
  assert.equal(kind({ status: 200 }, { ok: true }), undefined);
  assert.equal(kind({ status: 200 }, { error: { code: 'AUTH_ERROR' } }), 'unauthorized');
  assert.equal(kind({ status: 401 }, undefined), 'unauthorized');
  assert.equal(
    kind({ status: 401 }, { error: { code: 'AUTH_INVALID_CRED' } }, { login: true }),
    'refused',
  );
  assert.equal(kind({ status: 400 }, undefined, { login: true }), 'login_rejected');
  assert.equal(kind({ status: 403 }, { error: { code: 'AUTH_ERROR' } }), 'unauthorized');
  assert.equal(
    kind({ status: 403 }, '<html>'),
    'forbidden',
    'a CDN block is not a refused session',
  );
  assert.equal(kind({ status: 503 }), 'unavailable');
  assert.equal(kind({ status: 404 }), 'http');
  const limited = errorFor({ status: 429, headers: { 'retry-after': '120' } }, undefined);
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.retryAfter, 120_000);
  assert.equal(
    parseRetryAfter('Sat, 17 Oct 2026 08:01:00 GMT', Date.parse('2026-10-17T08:00:00Z')),
    60_000,
  );
  assert.equal(parseRetryAfter('soon'), undefined);
});

test('the reason of an error never carries free text from Picnic', () => {
  const err = errorFor(
    { status: 401 },
    { error: { code: 'AUTH_INVALID_CRED', message: 'jane@x' } },
    { login: true },
  );
  assert.equal(errorReason(err), 'e-mail or password refused (AUTH_INVALID_CRED, HTTP 401)');
  const odd = errorFor({ status: 400 }, { error: { code: 'not a code with spaces' } });
  assert.equal(errorReason(odd), 'request failed (HTTP 400)');
});

test('bodies: empty is nothing, broken is a bad answer', () => {
  assert.equal(parseJson(''), undefined);
  assert.deepEqual(parseJson('[]'), []);
  assert.throws(
    () => parseJson('<html>'),
    (err) => err instanceof PicnicError && err.kind === 'bad_response',
  );
});

test('the token expiry is read from the JWT when it is one', () => {
  assert.equal(tokenExpiry(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(tokenExpiry('opaque-token'), undefined);
  assert.equal(tokenExpiry('a.b%%.c'), undefined);
});

test('the transport: status, headers and body; bounded size; timeout', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/big') {
      res.end('x'.repeat(2048));
      return;
    }
    if (req.url === '/slow') {
      return; // never answers
    }
    res.setHeader('x-picnic-auth', 'token-2');
    res.statusCode = 201;
    res.end(JSON.stringify({ method: req.method, auth: req.headers['x-picnic-auth'] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const answer = await httpRequest(`${base}/ok`, {
    method: 'POST',
    headers: { 'x-picnic-auth': 'token-1' },
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.headers['x-picnic-auth'], 'token-2');
  assert.deepEqual(JSON.parse(answer.body), { method: 'POST', auth: 'token-1' });
  await assert.rejects(httpRequest(`${base}/big`, { maxBytes: 1024 }), { kind: 'size' });
  await assert.rejects(httpRequest(`${base}/slow`, { timeout: 100 }), { kind: 'timeout' });
  await assert.rejects(httpRequest('http://127.0.0.1:1/'), { kind: 'network' });
});
