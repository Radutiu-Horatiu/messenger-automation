/**
 * EXPORT THE CURRENT SESSION
 * --------------------------
 * Reads whatever session the persistent Chromium profile is already holding,
 * writes it to storageState.json plus a paste-ready base64 blob, and then
 * proves the blob authenticates on its own.
 *
 *   npm run save:session
 *
 * Use it when `npm run login` left you logged in but the export never ran
 * (closing the browser window skips it — the save happens when you press ENTER
 * in the terminal), or any time you want a fresh blob without logging in again.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { USER_AGENT, launchContext } from "./browser.js";
import { detectLoggedOut } from "./group.js";

type Cookies = Parameters<
  Awaited<ReturnType<typeof launchContext>>["addCookies"]
>[0];

/**
 * Load the exported cookies into a throwaway context with no persistent
 * profile behind it. This is the only way to know the blob stands on its own:
 * the profile directory could be doing the authenticating locally, and on the
 * host only the blob is guaranteed to be there.
 */
async function verifyBlobStandalone(statePath: string): Promise<boolean> {
  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw) as { cookies?: Cookies };

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    if (state.cookies?.length) await context.addCookies(state.cookies);

    const page = await context.newPage();
    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    const reason = await detectLoggedOut(page);
    if (reason) {
      logger.error({ reason }, "Exported session does NOT work on its own");
      return false;
    }
    logger.info("Exported session authenticates on a clean browser");
    return true;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const candidatePath = `${config.storage.storageStatePath}.candidate`;

  // Open the profile as-is; injecting the old storageState.json here would
  // overwrite the fresh profile cookies with the very ones we are replacing.
  const context = await launchContext({ applyStoredCookies: false });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    const reason = await detectLoggedOut(page);
    if (reason) {
      logger.error({ reason }, "The browser profile is NOT logged in");
      logger.error(
        "Run `npm run login` first — and press ENTER in the terminal when you are done, do not just close the window.",
      );
      process.exitCode = 1;
      return;
    }

    // Stage the export. These are credentials that cost a manual login to
    // regenerate, so the existing file is not touched until the new one has
    // proven it can authenticate by itself.
    await context.storageState({ path: candidatePath });
    logger.info({ path: candidatePath }, "Staged an export from the live profile");
  } finally {
    await context.close().catch(() => undefined);
  }

  if (!(await verifyBlobStandalone(candidatePath))) {
    await fs.unlink(candidatePath).catch(() => undefined);
    logger.error(
      "Discarded the export and left your existing storageState.json alone — re-run `npm run login`.",
    );
    process.exitCode = 1;
    return;
  }

  await fs.rename(candidatePath, config.storage.storageStatePath);
  const json = await fs.readFile(config.storage.storageStatePath, "utf8");
  const b64Path = path.join(config.storage.dataDir, "storageState.b64.txt");
  await fs.writeFile(b64Path, Buffer.from(json, "utf8").toString("base64"), "utf8");
  logger.info(
    { path: config.storage.storageStatePath },
    "Promoted the verified export to storageState.json",
  );

  logger.info(
    { b64Path },
    "Copy the contents of this file into FB_STORAGE_STATE_B64 on Railway, then redeploy.",
  );
}

main().catch((err) => {
  logger.error({ err }, "Failed to export the session");
  process.exit(1);
});
