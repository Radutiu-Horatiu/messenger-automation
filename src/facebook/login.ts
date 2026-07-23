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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
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

  await fs.mkdir(path.dirname(config.storage.storageStatePath), {
    recursive: true,
  });
  await context.storageState({ path: config.storage.storageStatePath });

  logger.info(
    { path: config.storage.storageStatePath },
    "Storage state saved. Upload this file to your Railway volume (/data).",
  );

  await browser.close();
}

main().catch((err) => {
  logger.error({ err }, "Login helper failed");
  process.exit(1);
});
