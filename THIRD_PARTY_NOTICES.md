# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the two projects below, both
distributed under the Apache License 2.0 too (the same text as `LICENSE`).
Neither project ships a `NOTICE` file. The ported parts were rewritten, not
copied: the changes are described below, as section 4 (b) of the license
asks.

## python-picnic-api2

<https://github.com/codesalatdev/python-picnic-api> (package
`python-picnic-api2`), by codesalatdev, a fork of the python-picnic-api of
MikeBrink, with fixes by maartenpaul and thijmen-j. Apache License 2.0
(`LICENSE.md` of the repository, commit 053ac02).

Ported in `src/constants.js`, `src/picnic.js` and `src/client.js`: the
storefront URL per country and the API version, the sign-in (`/user/login`
with the e-mail as `key`, the MD5 hex digest of the password as `secret`,
`client_id` 30100), the `x-picnic-auth` session header and its renewal from
the answers, the `x-picnic-agent` and `x-picnic-did` headers, the
authentication error codes (`AUTH_ERROR`, `AUTH_INVALID_CRED`), the
two-factor flow (`second_factor_authentication_required`,
`/user/2fa/generate` with `SMS` or `EMAIL`, `/user/2fa/verify` with the
`otp`), and the reads used (`/cart`, `/deliveries/summary`,
`/deliveries/<id>/position`). Changed: a per-installation `x-picnic-did`
instead of a fixed one; an HTTP status of 401 is an authentication error
too; one new sign-in at most per cycle.

## Home Assistant, Picnic integration

<https://github.com/home-assistant/core>, `homeassistant/components/picnic`
(commit 5cfe9aa), by the Home Assistant authors. Apache License 2.0.

Ported in `src/model.js` and `src/devices.js`: which delivery is the next one
(a `CURRENT` one) and which is the last order, the ETA taken from the
`eta_window` of the position and else from the `eta2` of the summary, the
position read only around the delivery, the order cut-off of the selected
slot when it is `EXPLICIT`, the cart count and total in euros (cents / 100),
and faster polling around the delivery window. Changed: the next delivery is
the CURRENT one with the earliest slot that has no `delivery_time` yet; the
cut-off prefers the booked delivery's while it is still to come; the polling
steps (5 minutes on the delivery day, 2 minutes around the delivery) and the
"delivery approaching" scene trigger are this integration's own.
