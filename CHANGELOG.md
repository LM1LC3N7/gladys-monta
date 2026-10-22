# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The charge points of a Monta account through the official Monta public API
  (client id and secret of an application of the Monta portal): status,
  connector, charging state, vehicle plugged in, state and energy of the
  charge, vehicle battery, meter reading (a plain sensor, never an energy
  index).
- "Stop the charge" button, always available, also during a pause asked by
  Monta and right after a restart; reaffirmed for 90 s when a start may still
  land.
- "Start a charge" button behind "Allow starting a charge" (off by default),
  decided on a fresh read, the option checked again right before sending.
- The limit of Monta (10 requests per minute) respected, with room kept for
  the commands; 429 and 5xx pauses persisted; refused credentials stop for
  good, without any automatic try.
- "Test the connection" button, documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-monta/commits/main
