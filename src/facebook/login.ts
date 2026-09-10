/**
 * LOGIN HELPER
 * ------------
 *   npm run login        log in THIS machine (local runs, check:session, debug:react)
 *   npm run login:host   mint a separate session for the host (Railway)
 *
 * Every place that runs the bot needs its own login. Facebook treats one login
 * cookie turning up from two networks at once — your home connection and a
 * datacenter — as a stolen cookie, and kills the session everywhere. That is
 * what happened when the local session was exported to the host and then used
 * locally again.
 *
 * `login:host` therefore logs in inside a throwaway browser profile, exports
 * the session to data/storageState.b64.txt, and deletes the profile without
 * logging out. The session then exists only in that blob, so nothing on this
 * machine can ever use it. Paste the blob into FB_STORAGE_STATE_B64.
 *
 * Both open a visible window: log in however Facebook asks ("Continue as…",
 * password, 2FA). The helper saves by itself the moment the login cookies
 * appear — there is nothing to press. Commit NOTHING.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { LOGIN_COOKIES, USER_AGENT } from "./browser.js";
import { detectLoggedOut } from "./group.js";

/** How long to wait for you to finish logging in before giving up. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2_000;
/**
 * Consecutive logged-in polls required before saving. Facebook sets its
 * cookies across a couple of redirects right after login; one clean poll can
 * land mid-flight.
 */
const STABLE_POLLS = 2;

const forHost = process.argv.includes("--host");

async function main(): Promise<void> {
  await fs.mkdir(config.storage.dataDir, { recursive: true });
  const profileDir = forHost
    ? await fs.mkdtemp(path.join(os.tmpdir(), "mautomation-host-login-"))
    : config.storage.profileDir;
  await fs.mkdir(profileDir, { recursive: true });

  logger.info(
    forHost
      ? "Logging in a NEW session for the host, in a throwaway browser profile..."
      : "Logging in this machine...",
  );

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: config.schedule.timezone,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    let closed = false;
    context.on("close", () => {
      closed = true;
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.facebook.com/login", {
      waitUntil: "domcontentloaded",
    });

    logger.info(
      "Log in to Facebook in the browser window — password, 2FA, whatever it asks. The session saves itself once you are in; there is nothing to press.",
    );

    // Previously this waited for ENTER in the terminal, and closing the window
    // instead silently skipped the export. Watching for the login itself
    // leaves no step to miss.
    const started = Date.now();
    let stable = 0;
    while (stable < STABLE_POLLS) {
      if (closed || !context.pages()[0]) {
        logger.error("The browser was closed before the login finished — nothing was saved.");
        process.exitCode = 1;
        return;
      }
      if (Date.now() - started > LOGIN_TIMEOUT_MS) {
        logger.error("Timed out waiting for the login to finish — nothing was saved.");
        await context.close().catch(() => undefined);
        process.exitCode = 1;
        return;
      }
      const reason = await detectLoggedOut(context.pages()[0]).catch(
        () => "page unavailable",
      );
      stable = reason === null ? stable + 1 : 0;
      if (stable < STABLE_POLLS) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
      }
    }

    const state = await context.storageState();
    await context.close();

    // Never hand over an export that cannot log in.
    const names = new Set(state.cookies.map((c) => c.name));
    const missing = LOGIN_COOKIES.filter((name) => !names.has(name));
    if (missing.length > 0) {
      logger.error({ missing }, "The export has no login cookies — nothing was saved.");
      process.exitCode = 1;
      return;
    }

    const json = JSON.stringify(state, null, 2);
    if (forHost) {
      const b64Path = path.join(config.storage.dataDir, "storageState.b64.txt");
      await fs.writeFile(b64Path, Buffer.from(json, "utf8").toString("base64"), "utf8");
      logger.info(
        { b64Path },
        "Host session saved. Paste this file's contents into FB_STORAGE_STATE_B64 and redeploy. It is not used on this machine, so it cannot collide with your local session.",
      );
    } else {
      await fs.writeFile(config.storage.storageStatePath, json, "utf8");
      logger.info(
        { path: config.storage.storageStatePath },
        "This machine is logged in — for local runs only. For the host, run `npm run login:host`.",
      );
    }
  } finally {
    if (forHost) {
      // Discard the profile WITHOUT logging out: logging out would kill the
      // very session we just handed to the host.
      await fs
        .rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
        .catch(() => undefined);
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "Login helper failed");
  process.exit(1);
});
