// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import {
  ACTIONS,
  APPROACH,
  CODE_CHANNELS,
  COUNTRIES,
  POLL_INTERVAL,
  SCENE_TRIGGERS,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, and the version set by hand to 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/, 'scene triggers need Gladys 5.1');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-picnic:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['services']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    // `[\s>]` lets a sentence run over the lines of a Markdown quote.
    assert.match(
      docs,
      /not[\s>]+affiliated[\s>]+with[\s>]+Picnic|sans[\s>]+lien[\s>]+avec[\s>]+Picnic/i,
    );
    assert.match(
      docs,
      /never[\s>]+tested[\s>]+with[\s>]+a[\s>]+real|jamais[\s>]+testée[\s>]+avec[\s>]+un[\s>]+vrai/i,
    );
    assert.doesNotMatch(docs, /chiffr|encrypt/i, 'a secret field is not encrypted by Gladys');
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(
    fields.country.options.map((o) => o.value),
    COUNTRIES,
  );
  assert.equal(fields.country.default, undefined, 'the country is a choice, never guessed');
  assert.equal(fields.email.type, 'string');
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  assert.ok(fields.email.required && fields.password.required && fields.country.required);
  for (const [key, range] of [
    ['poll_interval', POLL_INTERVAL],
    ['approach_minutes', APPROACH],
  ]) {
    assert.deepEqual([fields[key].min, fields[key].max], [range.min, range.max], key);
  }
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(intro.description[lang], /Picnic/);
  }
  assert.ok(intro.links.length <= 5 && intro.links.every((l) => l.url.startsWith('https://')));
});

test('the actions and their forms are those of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  const actions = Object.fromEntries(manifest.actions.map((a) => [a.key, a]));
  const channel = actions[ACTIONS.REQUEST_CODE].fields.find((f) => f.key === 'channel');
  assert.deepEqual(
    channel.options.map((o) => o.value),
    Object.keys(CODE_CHANNELS),
  );
  assert.ok(Object.keys(CODE_CHANNELS).includes(channel.default));
  assert.deepEqual(
    actions[ACTIONS.VERIFY_CODE].fields.map((f) => [f.key, f.type, f.required]),
    [['code', 'string', true]],
  );
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('the trigger variables are what the event carries', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key),
    Object.values(SCENE_TRIGGERS),
  );
  const [trigger] = manifest.scene_triggers;
  const sent = /pushSceneEvent\(SCENE_TRIGGERS\.DELIVERY_APPROACHING, \{([\s\S]*?)\}\);/.exec(
    app,
  )[1];
  const keys = [...sent.matchAll(/^\s+(\w+)[:,]/gm)].map((m) => m[1]);
  assert.deepEqual(
    trigger.variables.map((v) => v.key),
    keys,
  );
  assert.equal(trigger.fields, undefined);
});
