# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It signs in to Picnic
(NL, DE, BE, FR) with the e-mail and password of the app (plus a
verification code when Picnic asks), reads the cart and the deliveries, and
shows them read only on one Gladys device, with a "delivery approaching"
scene trigger. Unofficial API, never tested with a real account, not
affiliated with Picnic.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          PicnicApp: cycle and its timer, failures, stops and pauses,
                    device, states, scene event, badge, the three buttons
src/client.js       the account: sign-in, 2FA, session, one new sign-in per cycle, 3 reads
src/picnic.js       the only network access (node:https, bounded), errors, MD5, JWT exp
src/model.js        answers -> next delivery, last order, cart, cut-off, delays (pure)
src/devices.js      -> the Gladys device and its states (pure)
src/publisher.js    states and scene events within 300/min
src/store.js        /data/picnic-state.json: device id, session, pending sign-in, announced
src/config.js       config_schema normalized, account key (country + hash of the e-mail)
src/constants.js    hosts, paths, headers, manifest keys, limits, timings
src/i18n.js         runtime texts, device, feature and status names (en/fr)
test/fixtures/      answers shaped like python-picnic-api2's fixtures
test/helpers/       a fake Picnic behind the transport; Gladys is the SDK's fake
```

## Rules

- **External ids are forever**: device `account:<country>-<hash>`, features
  `next-slot-start`, `next-slot-end`, `eta`, `order-cut-off`,
  `last-order-status`, `cart-items`, `cart-total`. Never change how they are
  built.
- Manifest keys (`email`, `password`, `country`, `poll_interval`,
  `approach_minutes`, `language`, the actions `test_connection`,
  `request_code` (`channel`), `verify_code` (`code`), the trigger
  `delivery_approaching` and its variables) are frozen.
- **Read only**: never add a call that changes the cart or orders without an
  explicit, off-by-default setting (see TODO.md).
- **Never sign in again by itself after a refusal**, never request a
  verification code without a click, at most one new sign-in per cycle.
  Never log or put in a message the password, its hash, the token or a code.
- Polling politely: 2 requests per cycle (3 around a delivery), never under
  a minute; 429 pauses every path. Never add a call outside `PicnicClient`.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`; a `secret`
  field is kept by Gladys in its database, never write that it is encrypted.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
