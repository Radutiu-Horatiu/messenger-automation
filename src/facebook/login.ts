/**
 * ONE-TIME LOCAL LOGIN HELPER
 * ---------------------------
 * Run this locally (never on the server) to log in to Facebook by hand
 * and export the session cookies to STORAGE_STATE_PATH.
 *
 *   npm run login
 *
 * A visible Chromium window opens. Log in manually (handle any 2FA),
 * make sure you land on your normal feed, then press ENTER in the
 * terminal. The storage state is written to disk.
 *
 * Upload the resulting storageState.json to the Railway persistent
 * volume (/data). Commit NOTHING.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { USER_AGENT } from "./browser.js";

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  logger.info("Launching Chromium for manual login...");

  await fs.mkdir(path.dirname(config.storage.storageStatePath), {
    recursive: true,
  });
  await fs.mkdir(config.storage.profileDir, { recursive: true });

  // Use a persistent profile so the same browser state is reused on Railway.
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

  const page = await context.newPage();

  await page.goto("https://www.facebook.com/login", {
    waitUntil: "domcontentloaded",
  });

  logger.info(
    "A browser window is open. Log in to Facebook manually (including 2FA).",
  );

  await waitForEnter(
    "\n>>> When you are fully logged in and see your feed, press ENTER here to save the session...\n",
  );

  await context.storageState({ path: config.storage.storageStatePath });

  // Also emit a base64 blob. Pasting one variable into the host beats getting
  // a file onto a persistent volume, and this is a step you have to repeat
  // every time Facebook invalidates the session.
  const json = await fs.readFile(config.storage.storageStatePath, "utf8");
  const b64Path = path.join(config.storage.dataDir, "storageState.b64.txt");
  await fs.writeFile(b64Path, Buffer.from(json, "utf8").toString("base64"), "utf8");

  logger.info(
    { path: config.storage.storageStatePath, profileDir: config.storage.profileDir },
    "Storage state saved.",
  );
  logger.info(
    { b64Path },
    "Copy the contents of this file into the FB_STORAGE_STATE_B64 variable on your host, then redeploy.",
  );

  await context.close();
}

main().catch((err) => {
  logger.error({ err }, "Login helper failed");
  process.exit(1);
});
