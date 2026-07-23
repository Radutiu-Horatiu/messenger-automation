import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";

/** Realistic desktop user agent so Facebook trusts the session. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load cookies + origins from the exported storageState.json into a
 * persistent context. launchPersistentContext does not accept a
 * storageState option, so we inject cookies manually. The persistent
 * profile then keeps the session warm across redeployments.
 */
async function applyStorageState(context: BrowserContext): Promise<void> {
  const statePath = config.storage.storageStatePath;
  if (!(await fileExists(statePath))) {
    logger.warn(
      { statePath },
      "No storageState.json found. If this is the first run, log in locally and upload it.",
    );
    return;
  }

  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw) as {
      cookies?: Parameters<BrowserContext["addCookies"]>[0];
    };
    if (state.cookies && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      logger.info(
        { count: state.cookies.length },
        "Loaded cookies from storageState.json",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to apply storage state");
  }
}

export async function launchContext(): Promise<BrowserContext> {
  await fs.mkdir(config.storage.profileDir, { recursive: true });
  await fs.mkdir(path.dirname(config.storage.storageStatePath), {
    recursive: true,
  });

  logger.info(
    { profileDir: config.storage.profileDir, headless: config.browser.headless },
    "Launching persistent browser context",
  );

  const context = await chromium.launchPersistentContext(
    config.storage.profileDir,
    {
      headless: config.browser.headless,
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: config.schedule.timezone,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  );

  // tsx/esbuild wraps named functions with a __name() helper that does not
  // exist inside page.evaluate's browser context, causing
  // "ReferenceError: __name is not defined". Inject a no-op shim on every
  // page/navigation. Passed as a raw string so esbuild can't rewrite it.
  await context.addInitScript(
    "window.__name = window.__name || function (f) { return f; };",
  );

  await applyStorageState(context);
  return context;
}

/** Persist the freshest cookies back to disk so the session stays valid. */
export async function saveStorageState(context: BrowserContext): Promise<void> {
  try {
    await context.storageState({ path: config.storage.storageStatePath });
    logger.debug("Storage state refreshed on disk");
  } catch (err) {
    logger.warn({ err }, "Could not refresh storage state");
  }
}
