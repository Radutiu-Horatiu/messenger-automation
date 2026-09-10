import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";

/** Realistic desktop user agent so Facebook trusts the session. */
export const USER_AGENT =
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
 * The cookies that actually carry a Facebook login. Everything else Facebook
 * sets (datr, sb, dbln, wd, dpr…) only identifies the device — and a device
 * cookie alone is enough for Facebook to render a "Continue as <you>" page at
 * the root URL that looks logged in but is not.
 */
export const LOGIN_COOKIES = ["c_user", "xs"] as const;

/** True when the context currently holds both login cookies. */
export async function hasLoginCookies(context: BrowserContext): Promise<boolean> {
  const names = new Set(
    (await context.cookies("https://www.facebook.com")).map((c) => c.name),
  );
  return LOGIN_COOKIES.every((name) => names.has(name));
}

/**
 * Materialize storageState.json from FB_STORAGE_STATE_B64 when that variable
 * carries something we have not imported yet.
 *
 * Re-login is the one part of this system that cannot be automated, so the
 * step after it should be as cheap as possible: paste the new blob into the
 * host's variables instead of shipping a file to a volume. We fingerprint what
 * we import so a value that is merely still-set does not keep overwriting the
 * fresher cookies that healthy runs write back to disk.
 */
export async function importStorageStateFromEnv(): Promise<boolean> {
  const b64 = config.storage.storageStateB64;
  if (!b64) return false;

  const fingerprint = createHash("sha256").update(b64).digest("hex");
  const sourcePath = config.storage.storageStateSourcePath;
  const previous = await fs.readFile(sourcePath, "utf8").catch(() => "");

  if (previous.trim() === fingerprint) {
    logger.debug("FB_STORAGE_STATE_B64 already imported — keeping the copy on disk");
    return false;
  }

  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    JSON.parse(json); // fail loudly here rather than at addCookies time
    await fs.writeFile(config.storage.storageStatePath, json, "utf8");
    await fs.writeFile(sourcePath, fingerprint, "utf8");
    logger.info(
      { statePath: config.storage.storageStatePath },
      "Imported a new session from FB_STORAGE_STATE_B64",
    );
    return true;
  } catch (err) {
    logger.error(
      { err },
      "FB_STORAGE_STATE_B64 is not valid base64-encoded JSON — ignoring it",
    );
    return false;
  }
}

/**
 * Seed the persistent profile from storageState.json — but only when the file
 * is the better source.
 *
 * addCookies overwrites same-named cookies, so injecting unconditionally let a
 * stale file destroy a live login: log in with `npm run login`, skip the
 * export, and the very next launch loaded the old, dead xs over the fresh one;
 * Facebook then rejected it and cleared the login entirely. The profile is
 * written directly by the browser, so it is never staler than the file — except
 * right after a new FB_STORAGE_STATE_B64 is imported, which is an explicit
 * instruction to use those credentials instead.
 */
async function applyStorageState(context: BrowserContext): Promise<void> {
  const imported = await importStorageStateFromEnv();

  if (!imported && (await hasLoginCookies(context))) {
    logger.info(
      "Browser profile already holds a login — using it rather than loading storageState.json over it",
    );
    return;
  }

  const statePath = config.storage.storageStatePath;
  if (!(await fileExists(statePath))) {
    logger.warn(
      { statePath },
      "No storageState.json found — run `npm run login` locally and set FB_STORAGE_STATE_B64 from data/storageState.b64.txt.",
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
      const names = new Set(state.cookies.map((c) => c.name));
      const missing = LOGIN_COOKIES.filter((name) => !names.has(name));
      logger.info(
        { count: state.cookies.length, reason: imported ? "new FB_STORAGE_STATE_B64" : "profile had no login" },
        "Loaded cookies from storageState.json",
      );
      if (missing.length > 0) {
        logger.error(
          { missing },
          "storageState.json has no login cookies — it cannot log in. Re-run `npm run login` locally and paste the new blob.",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to apply storage state");
  }
}

/**
 * @param applyStoredCookies - when false, the persistent profile is opened
 *   exactly as it sits on disk. Exporting a session must not first inject the
 *   cookies from an older storageState.json, or addCookies would overwrite the
 *   fresher profile cookies and we would export the stale ones straight back.
 */
export async function launchContext(
  { applyStoredCookies = true }: { applyStoredCookies?: boolean } = {},
): Promise<BrowserContext> {
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

  if (applyStoredCookies) await applyStorageState(context);
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
