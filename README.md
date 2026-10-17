# gladys-picnic

[Gladys Assistant](https://gladysassistant.com) external integration for
**Picnic**, the online supermarket (Netherlands, Germany, Belgium, France),
read only: the start and end of the next delivery slot, its estimated arrival
when Picnic gives one, the order cut-off, the status of the last order, the
number of articles and the total of the cart, and a "delivery approaching"
scene trigger. **Unofficial API, never tested with a real account. Not
affiliated with Picnic.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PicnicApp)
                                  ├─ src/client.js     sign-in, 2FA, session, the 3 reads
                                  ├─ src/picnic.js     the only HTTP access, errors, MD5, JWT exp
                                  ├─ src/model.js      answers -> next delivery, last order, cart, delays (pure)
                                  ├─ src/devices.js    the device and its states (pure)
                                  ├─ src/publisher.js  states and scene events within 300/min
                                  └─ src/store.js      /data/picnic-state.json
```

- **Sign-in** (as python-picnic-api2): `POST /user/login` on
  `storefront-prod.<country>.picnicinternational.com/api/15` with the e-mail,
  the MD5 hex digest of the password and `client_id` 30100; the session
  token comes back in `x-picnic-auth`, is kept in `/data` (with a hash of
  the e-mail and the country) and replaced whenever an answer carries a new
  one. No sign-in per cycle.
- **Verification code**: when the sign-in answers
  `second_factor_authentication_required`, the integration stops and waits.
  Two Configuration-screen actions finish it: _Send the verification code_
  (`/user/2fa/generate`, SMS or e-mail) and _Verify the code_
  (`/user/2fa/verify`). Never requested by itself.
- **Reads**: `GET /cart` and `POST /deliveries/summary` per cycle, plus
  `GET /deliveries/<id>/position` around the delivery (its failure never
  hides the rest). Every 15 minutes (5–60), every 5 minutes on the delivery
  day (12 h before the slot), every 2 minutes from 45 minutes before the slot
  or ETA to 30 minutes after it.
- **Errors**: a refused token signs in again once and retries once (one new
  sign-in per cycle at most); refused again: a pause and one new try after
  1 h, 6 h, then every 24 h. A refused password, a rejected sign-in request
  (400/422) or a code asked: stop and a status message, until the
  configuration changes or a button is clicked. A 401 on the live position
  is ignored (the next cart read tells a dead session). 429: pause of `Retry-After` bounded to 1 min – 6 h
  (15 min without it), for every path, kept across Gladys reconnections.
  5xx/network: 2, 5, 10, 15, then 30 minutes. 403 without an authentication
  code: one hour, buttons included. Bodies are read up to 4 MiB.
- **Gladys side**: one device per account, `text` features for the times
  (Gladys has no date feature), a `currency`/`euro` total, a unit-less
  article count; the scene trigger `delivery_approaching` once per delivery
  when the ETA is within the configured lead.

## Credits

The sign-in, the two-factor flow, the hosts, headers and endpoints are ported
from [python-picnic-api2](https://github.com/codesalatdev/python-picnic-api)
(codesalatdev, after MikeBrink's python-picnic-api; Apache-2.0); the choice
of the next delivery, the last order, the ETA and the polling around the
delivery from the
[Home Assistant Picnic integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/picnic)
(Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
two-factor answers were cross-checked with
[picnic-api](https://github.com/MRVDH/picnic-api) (MRVDH, MIT; read, no code
taken). Modelled
on the sibling integration
[gladys-surepetcare](https://github.com/LM1LC3N7/gladys-surepetcare).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Picnic is a fake behind the injected
transport (answers shaped like the fixtures of python-picnic-api2), Gladys is
the SDK's fake; `test/picnic.test.js` runs the real transport against a
loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from Apache-2.0 projects,
credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in
the Docker image).
