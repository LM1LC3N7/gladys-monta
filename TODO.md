# TODO — Monta v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own: the batch reserved in /t/10385 (lot 13) gets one
  recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-22): client id and secret, token in
      memory (refresh, fallback to the client credentials once), the limit of
      10 requests per minute with room kept for the commands, charge points
      and charges read every interval, one device per charge point, status,
      connector, charging state, plugged, charge state, energy of the charge,
      vehicle battery, meter reading, stop always available (fresh read when
      free, else the charge kept in /data; watch of 90 s), start behind
      `allow_start` (off), test button, final stop on refused credentials,
      persisted 429/5xx pauses and time of the last attempt, docs en/fr,
      cover. Tested against a fake API only.
- [ ] **Milestone 2 — real account**: run against a real Monta account (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: the cost and price of the charge (currency
      feature, only with a unit the core lists), the wallet, the kWh and SoC
      limits of a charge, the webhooks of Monta (push instead of polling).

## To check on a real account

- The order of `charges` (sorted by id here) and whether `fromDate` filters on
  `createdAt`: a charge in progress older than 7 days would be missed.
- The answer of `POST charges` (the Charge, state `starting`?) and of
  `POST charges/{id}/stop` (state `stopping` or `stopped`?).
- Whether `busy` comes with an active charge, and what `passive` means for a
  charge point of a home user.
- The `Retry-After` of a 429 (seconds expected).
- The scopes needed: `charge-points`, `charge-transactions`, `control-charging`.

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first patch release gives 0.1.1.
  The manifest test never pins the version: only its form and its agreement.
- Reference: monta-python 1.2.0 (MIT, nickknissen), the client the Home
  Assistant integration of Monta uses; ported to JavaScript (no dependency),
  credited in THIRD_PARTY_NOTICES.md, copied into the image.
- Identity rule (fixes the external ids): `ext:<selector>:monta:<id>`, the
  Monta `id` of the charge point (a positive integer). Charge points without
  a serial number are skipped (as monta-python). Name fallback: "Monta <id>".
- No power feature: the public API gives none (`maxKw` is a parameter of the
  device). No invented value.
- `lastMeterReadingKwh` is a plain `charge-energy-consumption-total` sensor,
  never an `energy-sensor` index (the charge point is behind the main meter:
  the energy tab would count it twice) and never published as 0. Hence no
  P1 Monitor guard here.
- Energy of the charge: `consumedKwh` of the charge in progress, else of the
  latest one (`last-charge-energy-added`).
- Commands are two `button/push` features, never a switch nor a writable
  binary. Stop: no option (protective), never held back by a pause, a block or
  the limit (one request then), sent from the charge kept in /data before the
  first read after a restart, shared when clicked twice, reaffirmed (twice at
  most, for 90 s) when the stopped charge draws again or when a start of ours
  could still land; a charge started later by someone else is left alone.
- Start: `allow_start` (off) checked at the click and right before sending
  (beforeSend), with the account, the pause, a stop meanwhile and the 3.5 s
  deadline; decided on a fresh read of the charge point and its charges only
  (vehicle plugged in, ready state, no charge in progress); Gladys answered
  by 4.3 s ("sent, without confirmation" when Monta is still at work); a stop
  arriving during the start stops the new charge as soon as its id is known.
- A refused access token (401) is replaced and the request sent once more
  (Monta refused it before acting, as monta-python notes); at most one request
  with the client credentials per cycle.
- Final stops (no automatic try, persisted, lifted by new credentials or a
  successful test): 401 or another 4xx on `auth/token`, 403 on
  `charge-points`. A 403 on `charges` skips them for an hour; a 403 on a
  command refuses that command only.
- /data holds no secret: the time of the last attempt (before each read, at
  most once a minute), the pauses, the ids of the charge points and of their
  charge in progress, and a salted fingerprint of refused credentials only.
  Tokens stay in memory: a restart asks for a new one (one request).
- Rate limit: a sliding window of 60 s, 10 requests, shared by every client
  of the app; a periodic read needs 3 free plus 4 kept for the commands; a
  start needs 3 free; a stop is always sent.
- Never a read sooner than the interval (test button, `connected`, unchanged
  configuration, restart); only new credentials saved are tried at once. A
  follow-up read 20 s after a command ignores the interval but not the pauses
  nor the limit.
- At most 50 charge points, 2 pages of 100 per read.
