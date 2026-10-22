# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the charge points managed by
Monta, through the official Monta public API: a Node.js service (Node 22+,
ESM, no build step) that runs in its own sandboxed Docker container and talks
to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. The Monta client is a port of monta-python (MIT,
see THIRD_PARTY_NOTICES.md).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js            SDK wiring only
src/handlers.js     the SDK handlers (shared with the end-to-end tests)
src/app.js          reads, status, devices, badges, test button, commands
src/client.js       tokens (memory only), requests, the 10-per-minute limiter
src/monta.js        HTTPS transport (bounded), errors
src/model.js        Monta answers -> plain values (identity rule)
src/devices.js      a charge point -> a Gladys device and its states
src/publisher.js    states to Gladys within 300 per minute
src/store.js        /data: last attempt, pauses, final stop, charge ids
src/i18n.js         texts (en, fr)
```

## Rules

- **External ids are forever**: `ext:<selector>:monta:<id>` (the Monta id of
  the charge point) and the feature roles of `src/constants.js` FEATURES.
  Never rename one; never remove a feature (a republished device must not
  lose any).
- **Commands**: buttons only, never a switch nor a writable binary. Start
  stays behind `allow_start` (off by default), checked again right before
  sending; stop is never held back (no option, no pause, no limit).
- **Secrets**: the client secret and the tokens never reach a log, /data, a
  status or an error. /data holds only a salted fingerprint of refused
  credentials. Never claim more protection than Gladys gives: the secret is
  kept by Gladys in its database, never shown again (test/encoding.test.js).
- **Rate**: Monta allows 10 requests per minute per user; never read sooner
  than the interval (restart, reconnection, test button, unchanged config).
- **Units**: only those the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY`). No energy index.
- **Versions** belong to the Release workflow; `test/manifest.test.js` checks
  they agree, never a fixed value.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **Texts**: English and French, UTF-8 without BOM (`test/encoding.test.js`).
- **Style**: Prettier formats, ESLint catches mistakes. Tests never touch the
  network.
