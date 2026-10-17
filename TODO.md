# TODO — Picnic v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #241) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-17): sign-in (e-mail, MD5 of the
      password, country NL/DE/BE/FR), session token kept in `/data` and
      renewed from `x-picnic-auth`, two-step verification through two
      configuration actions, one read-only device (slot start/end, ETA,
      order cut-off, last order status, cart articles and total), scene
      trigger `delivery_approaching`, adaptive polling (15 min, 5 min on the
      delivery day, 2 min around it), 401/429/5xx/403 handling, badge,
      "Test the connection", docs en/fr, cover. Tested against made-up
      answers only.
- [ ] **Milestone 2 — real account**: run against a real account (see "To
      check on a real account"), turn the answers (anonymized) into
      fixtures, fix what differs.
- [ ] **Milestone 3 — write actions (not in v1)**: add a product to the cart
      (`/cart/add_product`, scene action, by product id or search), remove,
      clear; ordering stays out (payment). Off by default, behind an explicit
      setting, if ever.
- [ ] **Milestone 4 — more**: last order total and delivery time (Home
      Assistant has them), selected slot minimum order value, a dashboard
      widget, recipes/shopping-list sync.

## To check on a real account

- The sign-in answer: HTTP status of a wrong password (401 with
  `AUTH_INVALID_CRED`?), `user_id`, the `x-picnic-auth` header; is the token
  a JWT with an `exp` (shown nowhere yet, only used if present)?
- Two-step verification: does `/user/2fa/verify` send a new token in
  `x-picnic-auth`, or does the pre-auth token become valid (both handled)?
  How long does a code stay valid? Does a per-installation `x-picnic-did`
  avoid a code at the next sign-ins ("trusted device")?
- Does the API accept a random `x-picnic-did` (python-picnic-api2 sends a
  fixed one)? Is `x-picnic-agent` 30100;1.206.1 still accepted, and for FR
  and BE?
- `/deliveries/summary` with `[]`: order (most recent first?), statuses
  other than CURRENT/COMPLETED/CANCELLED, `delivery_time` once delivered.
- `/deliveries/<id>/position`: when does it start answering, `eta_window`
  and `eta` (ms) shapes; `eta2` on the summary: from when?
- `cart.selected_slot.state` values (`EXPLICIT`, `IMPLICIT`), `cut_off_time`
  of the slots.
- Rate limits: none documented; watch for 429, `Retry-After`, CDN 403s.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-picnic:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Own client on `node:https`, no Python** (Louis's rule: reuse maintained
  work): python-picnic-api2 (Apache-2.0, active, the library of Home
  Assistant) is the reference, ported to ~400 lines; the Home Assistant
  integration (Apache-2.0) for the sensors and the polling. The one npm
  client, `picnic-api` (MRVDH, MIT, 4.12.0 of 2026-10-16, active), was read
  (4.12.0, not used): its errors are plain `Error`s carrying Picnic's free
  text and dropping the HTTP status (no way to tell a refused session from a
  429 or a 5xx, no `Retry-After`), no timeout, no bound on the body, global
  `fetch`; it would need wrapping more than the three calls cost. It
  confirms two points of the protocol: `/user/2fa/verify` answers 204 with
  the new token in `x-picnic-auth` (handled; the pre-auth token is kept
  only if no header comes), and the 2FA calls carry the pre-auth token.
  Its newer `x-picnic-agent` (`30100;1.246.1-15599;`) is the fallback to try
  if Picnic refuses the library's one. Credited in README and
  `THIRD_PARTY_NOTICES.md` (shipped in the image); runtime dependencies: the
  SDK only.
- **Countries and URL as the library**: `storefront-prod.<cc>.picnicinternational.com/api/15`
  for NL, DE, BE, FR (the library uses one API version, 15, everywhere). The
  country is a required choice without default (a wrong guess would be a
  refused sign-in).
- **Password**: sent as the MD5 hex digest of its UTF-8 bytes, like the
  library; the plain password stays in the Gladys `secret` field (kept by
  Gladys in its database, never shown again, sent only to Picnic, hashed).
  `/data` never holds the e-mail nor the password.
- **Session**: the `x-picnic-auth` token kept in `/data` with
  `<country>:<sha256(e-mail)[0..16]>`; replaced by any new token an answer
  carries (the library does the same). No proactive renewal before an
  expiry: a new sign-in may ask for a code, so the integration signs in
  only when the token is refused.
- **401, as the brief asks** (revised after review): one new sign-in and
  one retry, at most one new sign-in per cycle; refused again
  (`session_refused`), a pause with a message and one new try (one sign-in)
  after 1 h, 6 h, then every 24 h, so the integration is never dead without
  a timer (wave-1 lesson). A try that is refused or asks for a code falls
  into the stops below, never requests a code. A refused password, a
  rejected sign-in request (400/422: "update the integration") and a code
  asked stop until a configuration change, _Test the connection_ or the code
  buttons: repeated refused sign-ins may lock the account, and a code needs
  the user anyway.
- **The live position never signs in**: a 401 there is logged and ignored,
  the session untouched (a token refused by that endpoint only must not
  stop the integration); the next cart read tells a really dead session.
- **Buttons**: _Test the connection_ signs in at most once per 30 s in every
  case (the last status is shown meanwhile), skips the live position and
  uses 8 s requests so it answers within its 60 s; a button clicked during a
  running read answers "in progress" instead of waiting for it. _Send the
  verification code_ answers "already connected" without any request while
  a session works (a new sign-in would only risk it). A 429 or a 403 (one
  hour) from a code button pauses every path; during a verification the
  status keeps the code message with the pause. A refusal of
  `/user/2fa/generate` is shown as "sending the code refused (CODE)", not as
  a refused code; a new token in its answer replaces the waiting one
  (session.py does the same). The one-code-a-minute limit is kept in
  `/data`.
- **429 pause** kept in `/data` and across a change of e-mail, password or
  country (`reset()` keeps it).
- **`/data` writes serialized** (a promise chain): two saves never share the
  temporary file.
- **Two-step verification in two actions** (manifest `actions` with
  `fields`): _Send the verification code_ (field `channel`: `sms`/`email`,
  signs in again if the waiting sign-in is older than 10 minutes, then
  `/user/2fa/generate`), _Verify the code_ (field `code`, 4–10 digits,
  `/user/2fa/verify`). Rather than config fields: a code stored in the
  configuration would stay there after use. A code is requested at most
  once a minute and never automatically (no SMS without a click). The
  waiting sign-in (its pre-auth token) is kept in `/data` so a restart
  between the two steps loses nothing. An older Gladys that drops the action
  fields gets a "update Gladys" message instead of a request.
- **`x-picnic-did` per installation**: 16 random upper-case hex digits made
  once in `/data` (the library sends a fixed one for every user); stable so
  the account sees one device. If Picnic refuses it on a real account,
  fall back to the library's value.
- **Device id** (revised after review, before the first release):
  `account:<Picnic user_id>` from the sign-in answer (Home Assistant's unique
  id), so changing the e-mail of the same account keeps the device. Fallback
  when the answer has no usable `user_id` (`[A-Za-z0-9_-]{1,64}`):
  `account:<country>-<sha256(e-mail)[0..16]>`. The key is chosen at the
  first publication and kept in `/data` per account, so it never flips
  later. No extra `GET /user` call.
- **Next delivery**: the CURRENT delivery without `delivery_time` with the
  earliest slot among those whose window (ETA included) + 30 min is still to
  come; a stale CURRENT one (no `delivery_time` left behind) only when there
  is no other (Home Assistant takes the last CURRENT of the list, the same
  one when the list is the most recent first). **Last order**: the most
  recent by `creation_time`, else the first of the list (Home Assistant:
  the first).
- **ETA**: the `eta_window` of the position, else the `eta2` of the summary;
  the arrival is the position's `eta` (ms) when given, else the window
  start. The position is read only around the delivery, as a secondary
  read: its failure is logged and ignored, except a 429 which pauses every
  path once the main data is shown.
- **Order cut-off "of the next slot"**: the booked delivery's while it is
  still to come (orders can still be changed), else the cart's selected slot
  when `EXPLICIT` (Home Assistant's rule), else the first available slot the
  cart offers. Only future cut-offs.
- **Times as `text` features** showing the local wall clock carried by
  Picnic's ISO string ("2026-10-18 14:15"): Gladys has no date feature, and
  the container's time zone is not the user's. `—` when there is nothing.
  The ETA shows its window when there is one: "14:48 (14:40–15:00)".
- **Units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): cart total
  `currency`/`decimal`/`euro` (euro is listed for currency; the four
  countries use the euro); article count `unknown`/`unknown` without unit
  (no count category with types exists in the core). Fixed at creation.
- **Statuses**: CURRENT/COMPLETED/CANCELLED shown as "À venir/Livrée/Annulée"
  (fr) or "Upcoming/Delivered/Cancelled" (en); any other status as Picnic
  sends it (at most 40 characters).
- **Polling**: 15 min by default (5–60), 5 min from 12 h before the slot,
  2 min from 45 min before the slot or ETA to 30 min after (Home Assistant:
  1 min from 30 min before to 2 h after: halved here to stay polite), never
  under a minute, waking exactly at the start of each window. 2 requests per
  cycle, 3 around the delivery.
- **"Delivery approaching"**: fired once per delivery id (the last 20 kept
  in `/data`, so a restart does not fire it again), only with an ETA from
  Picnic, when the arrival is at most `approach_minutes` away (15, 5–60) and
  the window is not over. Variables: `minutes`, `eta`, `slot_start`,
  `slot_end`. No trigger field: one account per Gladys.
- **429**: `Retry-After` bounded to 1 min – 6 h, 15 min without it; applies
  to the polling and to the three buttons; kept across Gladys
  reconnections. **403** without an authentication code (CDN): one-hour
  pause. **5xx/network**: 2, 5, 10, 15, then 30 minutes. Answers read up to
  4 MiB (a long delivery history), 20 s timeout (8 s for the buttons).
- **Read only**: `onSetValue` refuses; no cart change, no order in v1 (see
  Milestone 3).
- **Category `services`** in the store (no shopping category exists).
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #241).
