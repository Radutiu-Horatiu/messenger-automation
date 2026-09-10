/**
 * LOCAL LOGIN HELPER
 * ------------------
 * Run this on your own machine (never on the host) to log in to Facebook by
 * hand and export the session.
 *
 *   npm run login
 *
 * A visible Chromium window opens. Log in however Facebook asks — "Continue as
 * <you>", password, 2FA. The helper watches for the login cookies and saves
 * the session by itself the moment you are genuinely in; there is nothing to
 * press. It writes storageState.json plus data/storageState.b64.txt — paste
 * the latter into FB_STORAGE_STATE_B64 on the host. Commit NOTHING.
 */
import fs from "node:fs/promises";
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

async function main(): Promise<void> {
  logger.info("Launching Chromium for manual login...");

  await fs.mkdir(path.dirname(config.storage.storageStatePath), {
    recursive: true,
  });
  await fs.mkdir(config.storage.profileDir, { recursive: true });

  // Same persistent profile the bot uses, so the device looks the same.
  const context = await chromium.launchPersistentContext(
    config.storage.profileDir,
    {
      headless: false,
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: config.schedule.timezone,
      args: ["--disable-blink-features=AutomationControlled"],
    },
  );
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
  // instead silently skipped the export. Watching for the login itself leaves
  // no step to miss.
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
  await fs.writeFile(config.storage.storageStatePath, json, "utf8");
  const b64Path = path.join(config.storage.dataDir, "storageState.b64.txt");
  await fs.writeFile(b64Path, Buffer.from(json, "utf8").toString("base64"), "utf8");

  logger.info(
    { path: config.storage.storageStatePath, cookies: state.cookies.length },
    "Logged in — session saved.",
  );
  logger.info(
    { b64Path },
    "Copy the contents of this file into the FB_STORAGE_STATE_B64 variable on your host, then redeploy.",
  );
}

main().catch((err) => {
  logger.error({ err }, "Login helper failed");
  process.exit(1);
});
