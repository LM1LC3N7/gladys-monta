# Monta

Shows the charge points of your **Monta** account in Gladys, through the
official [Monta public API](https://docs.public-api.monta.com): state of the
charge point, vehicle plugged in, state and energy of the charge, vehicle
battery (when the vehicle reports it) and meter reading. A button stops the
charge; another one starts it, only if you allow it.

> Never tested with a real charge point: written from the public
> documentation of the API and from monta-python, and tested against made-up
> answers only. Not affiliated with Monta.

## Before you start

1. Sign in to the Monta portal (<https://portal2.monta.app>).
2. Open the user menu (bottom left), then **Applications**, then
   **+ Add Application**. Give it the scopes:
   - `charge-points` (the charge points; required),
   - `charge-transactions` (the charges: energy, battery, state; recommended),
   - `control-charging` (only for the start and stop buttons).
3. Copy the **client id** and the **client secret**. Monta shows the secret
   only once: if you lose it, use **Reset** in the list of applications.

## Configuration

| Field                   | Use                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Client id               | The client id of the application.                                                                          |
| Client secret           | Kept by Gladys in its database, never shown again, sent only to Monta, over HTTPS, to get an access token. |
| Allow starting a charge | Off by default. See "Commands".                                                                            |
| Refresh interval        | 120 s by default, 60 s to 1 h.                                                                             |
| Language                | Of the feature names, state texts and command errors.                                                      |

Save, then add the charge points from the **Discovery** tab.

## What you get

One device per charge point (its Monta id is the device identifier, forever):

| Feature              | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Status               | The state of the charge point (available, charging, plugged in without charging, error, disconnected from Monta...). |
| Connector            | Available, occupied, reserved, unavailable, faulted.                                                                 |
| Charging state       | Charging, vehicle connected, paused, idle.                                                                           |
| Vehicle plugged in   | 0 / 1.                                                                                                               |
| Charge               | The state of the charge in progress, or of the last one.                                                             |
| Energy of the charge | kWh of the charge in progress, or of the last one.                                                                   |
| Vehicle battery      | %, when the vehicle reports it.                                                                                      |
| Meter reading        | The last meter reading of the charge point, in kWh: a plain sensor, never counted by the energy tab.                 |
| Start a charge       | Button.                                                                                                              |
| Stop the charge      | Button.                                                                                                              |

The public API gives **no instantaneous power**: there is no power feature.
The meter reading is not an energy index: the charge point is behind your
main meter, counting it would count its energy twice. The location of the
charge point is never read into Gladys.

## Commands

- **Stop the charge** is always available: no option, never held back by a
  pause asked by Monta. It reads the charges of the charge point first when
  it can, else it stops the charge in progress known from the last read (kept
  in `/data`, so it works right after a restart). For 90 s after a stop, a
  charge that comes back is stopped again (twice at most); a charge someone
  starts later from the Monta app is left alone.
- **Start a charge** refuses unless "Allow starting a charge" is on. It reads
  the charge point and its charges just before sending, and sends only when
  a vehicle is plugged in, the charge point is ready and no charge is in
  progress. The option is checked again right before sending; a stop clicked
  meanwhile cancels it. Gladys gets its answer within 5 s: a start not
  answered by then is reported "sent, without confirmation" and the state
  follows.
- Both are buttons, never switches: a "turn everything off" can never reach
  them.

## Limits and errors

- Monta allows **10 requests per minute** for all the applications of your
  account. A read takes two requests (three when the token is renewed) and
  starts only when four stay free for the commands.
- Refused client id or secret: the integration stops for good (no automatic
  try, which could lock the application). Save corrected credentials, or
  click **Test the connection** once they are fixed on the Monta side.
- A 403 on the charge points (missing `charge-points` scope) stops the same
  way. A 403 on the charges only leaves the charge features as they were; a
  403 on a command only refuses that command.
- A 429 (too many requests) or a Monta outage pauses the reads (kept across a
  restart); stopping a charge stays possible.
- The integration never reads Monta sooner than the interval: not on a
  restart, a reconnection, an unchanged configuration saved, nor the test
  button. Only new credentials saved are tried at once.

## Privacy

Nothing secret is written to `/data`: only the time of the last read, the
pauses, the ids of the charge points and of their charge in progress, and,
after refused credentials, a salted fingerprint of those refused credentials
(erased at the first success). Tokens live in memory only and never reach the
logs.

Not affiliated with Monta. Monta is a trademark of its owner.
