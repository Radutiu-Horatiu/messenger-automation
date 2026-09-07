# Deployment

Two supported shapes on Railway. Both react identically; they differ only in
what you pay for between Sundays.

> **There are two schedulers and you must use exactly one.** `START_CRON` runs
> `node-cron` *inside* a permanently running process; Railway's **Cron Schedule**
> field starts the container *from outside* and expects it to exit. Setting both
> is the one combination that silently fails: Railway launches the container on
> its schedule, the in-process scheduler keeps it alive forever, and Railway then
> skips every later trigger because the previous run never finished. It fires
> once and appears dead thereafter. `RUN_ONCE=true` is what switches the app
> from the first shape to the second.

## A. Always-on service (simplest)

The container runs 24/7 and an in-process `node-cron` fires the session.

| Variable | Value |
| --- | --- |
| `START_CRON` | `0 10 * * 0` |
| `STOP_HOUR` | `22` |
| `TZ` | `Europe/Bucharest` |
| `EXIT_AFTER_REACT` | `true` |
| `RUN_ONCE` | *unset* |

Leave **Cron Schedule** empty in Railway. `node-cron` receives `TZ`, so the
10:00 start follows Bucharest time across DST automatically.

Cost note: you are billed for the idle baseline (~0.15 GB of RAM) every minute
of the week, which dominates the bill — the Sunday session itself is a rounding
error next to it.

## B. Railway cron (cheaper)

Railway starts the container on schedule and stops billing when the process
exits. Removes the idle baseline — roughly a 90% cut on this service.

| Variable | Value |
| --- | --- |
| `RUN_ONCE` | `true` |
| `START_HOUR` | `10` |
| `STOP_HOUR` | `22` |
| `TZ` | `Europe/Bucharest` |
| `EXIT_AFTER_REACT` | `true` |
| `START_CRON` | *ignored in this mode* |

Railway service settings:

- **Cron Schedule** → `0 7 * * 0`
- **Restart Policy** → `Never`

### Why 07:00 UTC plus `START_HOUR`

Railway evaluates cron expressions in **UTC only**, so a fixed expression
drifts an hour when Romania changes clocks. Point the cron at the earliest UTC
instant the target local hour can occur (07:00 UTC = 10:00 EEST in summer) and
`START_HOUR=10` makes the process sleep out the difference in winter, when
07:00 UTC is only 09:00 EET. The wait happens before Chromium launches, so the
hour of idling costs almost nothing.

| | Cron fires (UTC) | Local time | Sleeps | Session starts |
| --- | --- | --- | --- | --- |
| Summer (EEST, UTC+3) | 07:00 | 10:00 | 0 min | **10:00** |
| Winter (EET, UTC+2) | 07:00 | 09:00 | 60 min | **10:00** |

### Requirements this mode depends on

- **The process must exit.** `EXIT_AFTER_REACT=true` ends the session on the
  first successful reaction; `STOP_HOUR` is the give-up deadline if the target
  message never arrives. If a run is somehow still alive at the next scheduled
  trigger, Railway skips that trigger rather than running two at once.
- **Restart Policy must be `Never`.** The platform default is on-failure ×10,
  which would rerun a failed Sunday immediately, ten times over.
- **Keep the volume mounted at `/app/data`.** Volumes persist across cron runs
  and are billed for stored data whether or not the container is running. The
  session cookies, Chromium profile, dedupe DB, and failure screenshots all
  live there; losing it makes Facebook treat every run as a new device.

## C. Fast test loop (on Railway's cron)

Exercises the whole start -> detect -> react -> exit cycle against a throwaway
conversation, on the same machinery production will use. Railway's minimum
interval is 5 minutes, which is exactly the cadence we want.

Service settings:

- **Cron Schedule** -> `*/5 * * * *`
- **Restart Policy** -> `Never`

| Variable | Value | Why |
| --- | --- | --- |
| `FB_GROUP_URL` | *your test conversation* | |
| `RUN_ONCE` | `true` | **required** — without it the process never exits |
| `MAX_SESSION_MIN` | `3` | **required** — see below |
| `START_HOUR` | *unset* | **required** — see below |
| `EXIT_AFTER_REACT` | `true` | exit as soon as it reacts |
| `START_CRON` | *unset* | Railway drives the schedule now |
| `REACT_TO_EXISTING` | `false` | only react to messages sent *during* a window |
| `LOG_LEVEL` | `debug` | |
| `VERBOSE` | `true` | forwards the in-page observer diagnostics |

Two settings are load-bearing and easy to get wrong:

- **`MAX_SESSION_MIN=3`.** A run that finds no target message would otherwise
  stay open until `STOP_HOUR`, and Railway skips any trigger that arrives while
  the previous run is alive — so you would get one run and then silence. Three
  minutes of watching plus ~30-60s of container and browser startup fits inside
  the 5-minute window with room to spare.
- **`START_HOUR` must be unset.** If it is left at `10`, every run started
  before 10:00 local sleeps until 10:00 instead of watching, and holds the slot
  while it does. It exists only to correct for UTC drift on the weekly schedule.

Post `Marti?` in the test conversation *after* a run has started; messages
already on screen when the observer attaches are marked seen and ignored. Watch
**Cron Runs** in Railway for the trigger history, and the deploy logs for
`Target message detected` / `Applied Messenger reaction`.

### Switching back to production

- **Cron Schedule** -> `0 7 * * 0`
- `FB_GROUP_URL` -> the real conversation
- `START_HOUR` -> `10`
- remove `MAX_SESSION_MIN`, `VERBOSE`, and `LOG_LEVEL=debug`
- leave `RUN_ONCE=true` and `EXIT_AFTER_REACT=true` as they are

## Session cookies

`storageState.json` and `facebook-profile/` are produced locally by
`npm run login` and uploaded to the volume. Never commit them.

### Checking them

    npm run check:session

Prints the real expiry of the `c_user` and `xs` cookies, loads a logged-in page
to confirm Facebook still accepts them, and exits non-zero (plus a Discord
notification) if it is dead. It never writes cookies back, so it is safe to run
against the live data dir at any time.

### Keeping them alive

There is no refresh-token flow to automate. What renews the session is simply
using it: every healthy run writes the freshest cookies back to
`storageState.json`, so a weekly run keeps them rolling on its own.

What breaks a session is server-side invalidation — a password change, "log out
of all devices", 2FA re-challenge, or Facebook deciding the login looks
suspicious. Running from a datacenter IP makes that last one much more likely,
so:

- Keep the volume. A stable Chromium profile means a stable device fingerprint;
  losing it makes every run look like a brand-new device.
- Log in with "Remember me" so `xs` is a persistent cookie. `check:session`
  warns if it is a session cookie, which would not survive a restart.
- Prefer a Railway region near you, so the login location does not jump
  continents between the manual login and the scheduled run.

When a session *is* genuinely dead, re-login is manual and cannot be
automated — it may require 2FA. Run `npm run login` locally, then upload the
new `storageState.json` to the volume.
