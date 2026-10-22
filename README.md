# gladys-monta

A [Gladys Assistant](https://gladysassistant.com) external integration for the
charge points managed by **Monta** (Denmark, Sweden, Norway, Germany, the
Netherlands, Finland...), through the official Monta public API: state of the
charge point, vehicle plugged in, state and energy of the charge, vehicle
battery, meter reading; stop the charge (always), start one (off by default).

Never tested with a real charge point. Not affiliated with Monta.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Next steps and decisions:
  [TODO.md](TODO.md).
- Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (a
  JavaScript port of parts of monta-python, MIT).

## How it works

- **Account**: the client id and secret of an application created in the
  Monta portal are exchanged for an access token (1 h), renewed from the
  refresh token (30 days); a refused refresh token falls back to the client
  credentials once. Tokens stay in memory only.
- **Reads**: every interval (120 s by default), `charge-points` then
  `charges` (the last 7 days, all charge points at once). Monta allows 10
  requests per minute for all the applications of a user: a read starts only
  when four requests stay free for the commands.
- **Devices**: one per charge point, keyed by its Monta id. Read-only
  features, plus two `button/push` features (start, stop): never a switch.
- **Commands**: stop always possible (also during a 429/5xx pause, from the
  charge kept in `/data` after a restart), reaffirmed for 90 s if a start of
  ours may still land; start behind `allow_start` (off), decided on a fresh
  read, option checked again right before sending, cancelled by a stop.
- **Errors**: refused credentials (or a 403 on the charge points) stop for
  good, persisted, with no automatic try; 429 and 5xx pause, persisted and
  bounded; never a read sooner than the interval.

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npx github:GladysAssistant/integration-store .
```

Tests use the SDK's fake Gladys and a fake Monta API (no network). See
[CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Parts ported from monta-python are under
the MIT license of their author (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
