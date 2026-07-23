# messenger-automation

A deterministic Facebook group **auto-reaction bot**. It opens a group feed on a
schedule, keeps the page alive, watches for new posts with a `MutationObserver`
(no polling, no refreshing), and reacts to posts whose text matches a target.
Built with **TypeScript + Playwright**. No AI, no managed browsers.

## How it works

```
Cron (Sunday 10:00)
   -> launch persistent Chromium (cookies from storageState.json)
   -> open the Facebook group
   -> inject MutationObserver
        new post -> match text -> click reaction -> mark "reacted"
   -> small human-like keep-alive every few minutes
   -> close browser at STOP_HOUR (22:00)
```

## Project layout

```
src/
  facebook/
    login.ts       one-time local login -> exports storageState.json
    browser.ts     launches persistent context, loads cookies
    group.ts       opens the group, verifies session
    observer.ts    injects the MutationObserver
    reaction.ts    finds + clicks the reaction
    keepalive.ts   human-like idle prevention
  services/
    scheduler.ts   node-cron trigger
    session.ts     orchestrates one daily session
    matcher.ts     exact / includes text matching
    discord.ts     webhook notifications
    logger.ts      pino logger
  storage/
    reacted.ts     dedupe store (reacted.json)
  config.ts        env-driven config
  index.ts         entrypoint
```

## Setup

1. **Install**

   ```bash
   npm install
   npx playwright install chromium
   ```

2. **Configure** — copy `.env.example` to `.env` and fill it in:

   ```bash
   cp .env.example .env
   ```

   At minimum set `FB_GROUP_URL` and `TARGET_TEXT`. For local runs point the
   `*_PATH` / `*_DIR` values at a local folder (e.g. `DATA_DIR=./data`).

3. **Log in once (locally, never on the server)**

   ```bash
   npm run login
   ```

   A Chromium window opens. Log in to Facebook manually (including 2FA), then
   press ENTER in the terminal. This writes `storageState.json` to
   `STORAGE_STATE_PATH`. **Commit nothing** — this file is your session.

## Running

- **Scheduled (default):** registers the cron trigger and stays alive.

  ```bash
  npm run dev      # ts, no build
  # or
  npm run build && npm start
  ```

- **Run one session now** (great for testing / one-shot cron deploys):

  ```bash
  npm run run:once
  ```

For local visual debugging set `HEADLESS=false` in `.env`.

## Deploy to Railway

1. Create a **Persistent Volume** mounted at `/app/data`.
2. Deploy this repo with the included `Dockerfile`.
3. Upload your locally-generated `storageState.json` to the volume at
   `/app/data/storageState.json`.
4. Set environment variables (see `.env.example`). Keep the defaults:
   - `DATA_DIR=/app/data`
   - `STORAGE_STATE_PATH=/app/data/storageState.json`
   - `PROFILE_DIR=/app/data/facebook-profile`
   - `REACTED_DB_PATH=/app/data/reacted.json`
5. Choose one of:
   - **Always-on service** — leave the default command (`npm start`). The
     internal `node-cron` schedule (`START_CRON`) fires each session.
   - **Railway Cron** — set the service to run `npm run run:once` on your cron
     schedule; each run performs a single session.

Cookies live on the volume, so they survive redeploys — no weekly re-login.

## Refreshing the session token

If Railway logs show the session is invalid, regenerate the cookies locally and
re-upload them to the volume. Never run `npm run login` inside the container.

1. **Generate a fresh session locally**

   ```bash
   npm run login
   ```

   This overwrites `data/storageState.json` and `data/facebook-profile/`.

2. **(First time only) add an SSH key to Railway**

   ```bash
   ssh-keygen -t ed25519 -C "you@example.com" -f ~/.ssh/railway
   cat ~/.ssh/railway.pub | railway ssh keys add
   ```

3. **Upload the updated files to the Railway volume**

   ```bash
   railway volume files upload ./data/storageState.json /storageState.json
   railway volume files upload ./data/facebook-profile /facebook-profile
   ```

   Files at the volume root become `/app/data/storageState.json` and
   `/app/data/facebook-profile/` inside the container.

4. **Trigger a redeploy** if you want the new session used immediately:

   ```bash
   railway up
   ```

## Configuration reference

| Variable | Purpose | Default |
| --- | --- | --- |
| `FB_GROUP_URL` | Group feed URL to watch | — (required) |
| `TARGET_TEXT` | Text to match on new posts | — (required) |
| `MATCH_MODE` | `exact` or `includes` | `includes` |
| `REACTION` | `like`/`love`/`care`/`haha`/`wow`/`sad`/`angry` | `like` |
| `START_CRON` | When a session starts | `0 10 * * 0` (Sun 10:00) |
| `STOP_HOUR` | Hour (0-23) to shut down | `22` |
| `TZ` | Scheduler timezone | `UTC` |
| `HEADLESS` | Headless browser | `true` |
| `KEEPALIVE_INTERVAL_MIN` | Minutes between keep-alive nudges | `3` |
| `DISCORD_WEBHOOK_URL` | Status notifications | _(off)_ |
| `LOG_LEVEL` | pino level | `info` |

## Notes & limitations

- Facebook's DOM changes often. `reaction.ts` and `observer.ts` use role- and
  aria-label-based locators, but you may need to adjust selectors over time.
- Respect Facebook's Terms of Service and your group's rules. Use responsibly.
- Duplicate protection is keyed by post id (pfbid/permalink) with a text-hash
  fallback, persisted in `reacted.json`.

## Future: multiple rules

`rules.json` support (one bot, many groups/reactions) is a natural extension of
`matcher.ts` + `session.ts`. See `rules.example.json`.
