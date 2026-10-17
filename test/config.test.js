// -----------------------------------------------------------------------------
// src/config.js and src/store.js: the configuration and /data, repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey, normalizeConfig } from '../src/config.js';
import { fileStore, newDeviceId, normalizeMemory } from '../src/store.js';

test('the configuration: trimmed, bounded, defaults', () => {
  assert.deepEqual(normalizeConfig({}), {
    email: '',
    password: '',
    country: '',
    account: '',
    pollInterval: 15,
    approachMinutes: 15,
    language: 'fr',
  });
  const config = normalizeConfig({
    email: ' Jane@Example.com ',
    password: ' p ',
    country: 'be',
    poll_interval: 1,
    approach_minutes: 600,
    language: 'EN',
  });
  assert.equal(config.email, 'Jane@Example.com');
  assert.equal(config.password, ' p ', 'a password is kept as typed');
  assert.equal(config.country, 'BE');
  assert.equal(config.account, `BE:${accountKey('jane@example.com')}`);
  assert.equal(config.pollInterval, 5);
  assert.equal(config.approachMinutes, 60);
  assert.equal(config.language, 'en');
  assert.equal(normalizeConfig({ email: 'a@b', password: 'p', country: 'ES' }).account, '');
});

test('the persisted state: repaired, never trusted', () => {
  assert.deepEqual(normalizeMemory(null), {
    did: null,
    session: null,
    pending: null,
    codeAt: undefined,
    rateLimitedUntil: undefined,
    deviceKey: null,
    announced: [],
  });
  const memory = normalizeMemory({
    did: 'ABCDEF0123456789',
    session: { account: 'FR:x', token: 't', expiresAt: 'later' },
    pending: { account: 'FR:x', token: 'p' },
    announced: ['a', 2, 'b'],
  });
  assert.deepEqual(memory.session, {
    account: 'FR:x',
    token: 't',
    expiresAt: undefined,
    userId: undefined,
  });
  assert.equal(memory.pending, null, 'a pending sign-in without its date is dropped');
  assert.deepEqual(memory.announced, ['a', 'b']);
  assert.equal(normalizeMemory({ did: '../etc' }).did, null);
  assert.match(newDeviceId(), /^[0-9A-F]{16}$/);
});

test('the file store writes atomically, readable by its owner only', async (t) => {
  // Inside the repository, not the system temporary directory.
  const dir = await mkdtemp(join(fileURLToPath(new URL('..', import.meta.url)), '.test-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ did: 'X' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { did: 'X' });
  assert.deepEqual(await store.load(), { did: 'X' });
  // Saves at the same time never share the temporary file: the last one wins.
  await Promise.all(Array.from({ length: 20 }, (_, n) => store.save({ n })));
  assert.deepEqual(await store.load(), { n: 19 });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});
