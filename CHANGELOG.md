# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

### Fixed

- A stop whose fresh read joined a slow token renewal could answer Gladys
  after its 5 s: the wait is now bounded by the deadline of the command, the
  stop going on from the charge kept ("Stop not sent yet: it waits for a
  token from Monta").
- The message of a stop waiting for a token no longer promises it will leave:
  it leaves only if Monta gives the token. Described in the docs.

## [0.1.1] - 2026-10-22

### Added

- The charge points of a Monta account through the official Monta public API
  (client id and secret of an application of the Monta portal): status,
  connector, charging state, vehicle plugged in, state and energy of the
  charge, vehicle battery, meter reading (a plain sensor, never an energy
  index).
- "Stop the charge" button, always available, also during a pause asked by
  Monta, at the limit of requests and right after a restart; a charge kept as
  in progress is never dropped because it left the 7-day read; watched after
  the stop (90 s, up to 10 min when resends fail), any charge stopped when a
  start of ours may still land.
- "Start a charge" button behind "Allow starting a charge" (off by default),
  decided on a fresh read (never on a charge point already charging), the
  option checked again right before sending.
- The limit of Monta (10 requests per minute) respected and kept across a
  restart, with room kept for a stop; 429 and 5xx pauses persisted per
  account; a 5xx on the charges alone pauses nothing; refused credentials
  stop for good, without any automatic try, also from a command.
- A command that never left (token, checks, deadline) is reported "not
  sent", never "sent, without confirmation".
- "Test the connection" button, documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-monta/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-monta/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-monta/releases/tag/v0.1.1
