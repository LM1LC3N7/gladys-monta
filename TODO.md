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
  the limit (one request then), shared when clicked twice. Its charge: the one
  in progress of a fresh read (one request when it leaves room for the stop
  and, when the periodic read is due, for that read too; only a read made
  by a stop of the same charge point in the last 30 s is reused, never a
  periodic one: a charge may start right after it), else the charge kept (never one the fresh
  read saw finished). A charge kept as in progress is let go only when seen
  finished or when the charge point is no longer busy: absent from the bounded
  7-day read is never "nothing in progress". Success without sending only
  when a fresh read shows nothing and the charge point is not charging;
  otherwise an exact refusal (the reason of the missing read, or "charging but
  no charge of the last 7 days").
- Watch after a stop: 90 s and at least until a read after it; the stopped
  charge drawing again is stopped again, twice at most; when a start of ours
  may still land (in flight or unconfirmed), any active charge (reserved,
  scheduled, paused included, `stopping` aside) is stopped, also one started
  from the Monta app in that window. A stop that can neither read nor find a
  charge still arms the watch then (and says so). A failed resend is not
  counted and lengthens the watch, 10 minutes at most; follow-up reads are a
  minute apart at least.
- Start: `allow_start` (off) checked at the click and right before sending
  (beforeSend), with the account, the pause, a stop meanwhile and the 3.5 s
  deadline; decided on a fresh read of the charge point and its charges only
  (vehicle plugged in, ready state, no charge in progress, the charge point
  not `busy-charging`: then nothing is sent); Gladys answered by 4.3 s ("sent,
  without confirmation" when Monta is still at work); a stop arriving during
  the start stops the new charge as soon as its id is known.
- Anything failing before the command itself left (the token, the checks,
  the deadline) is `notSent`: "not sent", never "sent, without confirmation",
  and no "may land" window. Credentials refused while a command gets its
  token: the same final stop as for a read; a command never sends refused
  credentials again (no loop from a scene).
- A refused access token (401) is replaced and the request sent once more
  (Monta refused it before acting, as monta-python notes); one request with
  the client credentials per read cycle, and one per command of its own.
- A token whose expiry is already (nearly) past on arrival (clocks apart):
  the documented lifetime instead, never a renewal before every request.
- Final stops (no automatic try, persisted): 401 or another 4xx on
  `auth/token` (with a salted fingerprint of the refused credentials, lifted
  by other credentials or a successful test), 403 on `charge-points` (no
  fingerprint: credentials accepted; lifted by saving the credentials again
  or a successful test). A 403 on `charges` skips them for an hour, a 5xx for
  the backoff, without pausing anything else; a 403 on a command refuses that
  command only.
- /data holds no secret: the time of the last attempt (before each read, at
  most once a minute), the times of the requests of the last minute, the
  pauses (with their account), the ids of the charge points and of their
  charge in progress, and a salted fingerprint of refused credentials only.
  Tokens stay in memory: a restart asks for a new one (one request).
- Rate limit: a sliding window of 60 s, 10 requests, shared by every client
  of the app and kept across a restart; a periodic read needs 5 free (token,
  2 pages, charges, one new try) plus 3 kept for a stop; a start needs 5; a
  stop is always sent.
- Never a read sooner than the interval (test button, `connected`, unchanged
  configuration, restart); only new credentials saved are tried at once. A
  follow-up read after a command ignores the interval but not the pauses nor
  the limit, and two are a minute apart at least.
- The generation of the configuration is checked after every await, in the
  reads, the commands and their errors: a late answer of an old
  configuration never pauses, blocks nor sets the status of the new one.
- At most 50 charge points, 2 pages of 100 per read; charges read over 7
  days, 100 per request.
- A start is refused while a charge kept as in progress is not seen finished
  and the charge point is busy (it may have left the 7-day list).
- A stop has no deadline to leave (protective): it goes as soon as a token
  is in hand. Gladys is told "sent, without confirmation" only if it really
  left by the answer; otherwise "not sent yet, it leaves with the token".
- The status after a failed read of the charges names the scope only for a
  403; an outage says the charges are unavailable and when they are tried
  again.
