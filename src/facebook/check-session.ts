/**
 * SESSION HEALTH CHECK
 * --------------------
 * Answers "are my Facebook cookies still good, and when do they die?"
 * without waiting for the scheduled run to find out the hard way.
 *
 *   npm run check:session
 *
 * Exits 0 when the session is valid, 1 when it needs a manual re-login.
 * Safe to run against the live data dir: it never writes cookies back.
 */
import fs from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { LOGIN_COOKIES, launchContext } from "./browser.js";
import { detectLoggedOut } from "./group.js";

interface StoredCookie {
  name: string;
  expires?: number;
}

/** Report the expiry of each auth cookie found in storageState.json. */
async function reportCookieExpiry(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(config.storage.storageStatePath, "utf8");
  } catch {
    logger.warn(
      { path: config.storage.storageStatePath },
      "No storageState.json on disk — the persistent profile is the only session source",
    );
    return;
  }

  const state = JSON.parse(raw) as { cookies?: StoredCookie[] };
  const now = Date.now() / 1000;

  for (const name of LOGIN_COOKIES) {
    const cookie = state.cookies?.find((c) => c.name === name);
    if (!cookie) {
      logger.warn({ cookie: name }, "Auth cookie missing from storageState.json");
      continue;
    }
    // Playwright uses -1 for session cookies (die when the browser closes).
    if (cookie.expires === undefined || cookie.expires <= 0) {
      logger.warn(
        { cookie: name },
        "Auth cookie is a SESSION cookie — it will not survive; re-login with 'Remember me' enabled",
      );
      continue;
    }
    const daysLeft = Math.round((cookie.expires - now) / 86_400);
    logger.info(
      { cookie: name, expires: new Date(cookie.expires * 1000).toISOString(), daysLeft },
      daysLeft > 0 ? "Auth cookie valid" : "Auth cookie EXPIRED",
    );
  }
}

async function main(): Promise<void> {
  await reportCookieExpiry();

  const context = await launchContext();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.facebook.com/me", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    const reason = await detectLoggedOut(page);
    if (reason) {
      logger.error({ url: page.url(), reason }, "SESSION INVALID");
      logger.error(
        "Fix: run `npm run login` to log this machine back in. (The host has its own session — see its logs.)",
      );
      process.exitCode = 1;
      return;
    }

    logger.info({ url: page.url() }, "SESSION VALID — still logged in");
  } finally {
    // Deliberately no saveStorageState() here: a check must never be able to
    // overwrite good cookies with whatever this probe happened to produce.
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  logger.error({ err }, "Session check failed");
  process.exit(1);
});
