# Deployment

Two supported shapes on Railway. Both react identically; they differ only in
what you pay for between Sundays.

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

## Session cookies

`storageState.json` and `facebook-profile/` are produced locally by
`npm run login` and uploaded to the volume. Never commit them.
