# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Sign-in to Picnic (Netherlands, Germany, Belgium, France) with the e-mail,
  the password (sent as its MD5 digest, like python-picnic-api2) and the
  country; the session token kept in `/data` and renewed from the answers,
  no sign-in per cycle.
- Two-step verification when Picnic asks for it: the integration stops and
  says so; "Send the verification code" (SMS or e-mail) and "Verify the
  code" finish the sign-in from the configuration screen. No code is ever
  requested by itself.
- One read-only Picnic device: start and end of the next delivery slot, its
  estimated arrival when Picnic gives one, the order cut-off, the status of
  the last order, the number of articles and the total of the cart.
- Scene trigger "Picnic delivery approaching", once per delivery, when the
  estimated arrival is within the configured lead (15 minutes by default).
- Reads every 15 minutes (5 to 60), every 5 minutes on the delivery day and
  every 2 minutes around the delivery, with the live position.
- Resilience: a refused token signs in again once, then the integration
  stops with a message; a refused password stops until the configuration
  changes or the test button is clicked; 429 pauses every path (1 minute to
  6 hours); 5xx and network errors retried after 2 to 30 minutes.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.
