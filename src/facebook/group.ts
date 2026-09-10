import { type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { hasLoginCookies } from "./browser.js";

/**
 * Decide whether Facebook is refusing this session, returning a human-readable
 * reason or null when we are genuinely logged in.
 *
 * The decisive test is positive: the login cookies must be present. The
 * negative signals alone — login URL, visible password field — missed the
 * "Continue as <you>" remembered-account page, which Facebook serves at the
 * plain root URL with neither. That page passed as a live session, so a dead
 * one was exported, "verified" and shipped to the host.
 */
export async function detectLoggedOut(page: Page): Promise<string | null> {
  const url = page.url();
  if (url.includes("/login") || url.includes("login.php")) {
    return `redirected to the login page (${url})`;
  }
  if (
    url.includes("/checkpoint") ||
    url.includes("two_step_verification") ||
    url.includes("/auth_platform")
  ) {
    return `hit a security checkpoint (${url})`;
  }

  if (!(await hasLoginCookies(page.context()))) {
    return "no login cookies (c_user/xs) — Facebook is showing the logged-out \"Continue as…\" page";
  }

  // Facebook's login form names its password field "pass" (checked against
  // the live page). Match on that, not on any password input: Messenger shows
  // its own PIN prompt for restoring end-to-end-encrypted chat history on
  // unfamiliar devices — and a fresh Railway container is exactly that. Taking
  // the PIN prompt for a logout kills every run on the host while everything
  // works locally, where the device is already known.
  const loginPassword = page
    .locator('input[type="password"][name="pass"]')
    .filter({ visible: true })
    .first();
  if (await loginPassword.isVisible({ timeout: 1_000 }).catch(() => false)) {
    return "Facebook is asking for the account password (session no longer trusted)";
  }

  return null;
}

/**
 * Open the target group feed and confirm the session is still valid.
 * Throws if Facebook redirects us to a login/checkpoint screen.
 */
export async function openGroup(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());

  logger.info({ url: config.facebook.groupUrl }, "Opening Facebook group");
  await page.goto(config.facebook.groupUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Give the SPA a moment to settle, then verify we weren't redirected.
  await page.waitForTimeout(4_000);
  const loggedOutReason = await detectLoggedOut(page);
  if (loggedOutReason) {
    await logPageState(page);
    throw new Error(`Facebook rejected the session — ${loggedOutReason}`);
  }

  const otherSecretField = page
    .locator('input[type="password"]:not([name="pass"])')
    .filter({ visible: true })
    .first();
  if (await otherSecretField.isVisible({ timeout: 500 }).catch(() => false)) {
    logger.info(
      "A PIN/password prompt is on screen but it is not Facebook's login form — most likely Messenger's chat-history PIN. Not a logout; dismissing it.",
    );
  }

  await dismissOverlays(page);
  logger.info("Group feed is open and session looks valid");
  return page;
}

/**
 * Log what Facebook actually put on screen. On the host there is no window to
 * look at, so this line is the only way to tell a real logout from a
 * checkpoint or an unexpected dialog.
 */
async function logPageState(page: Page): Promise<void> {
  const title = await page.title().catch(() => "");
  const dialog = page.locator('[role="dialog"]').filter({ visible: true }).first();
  const dialogText = (await dialog.isVisible({ timeout: 500 }).catch(() => false))
    ? (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)
    : null;
  logger.warn(
    { url: page.url(), title, dialog: dialogText },
    "Page state when the session was rejected",
  );
}

/**
 * Buttons that answer a consent/permission prompt. These dialogs cannot be
 * closed with Escape — they must be answered. English + Romanian, because
 * the dialog language follows the ACCOUNT locale, not the browser locale.
 */
const CONSENT_LABELS = [
  "Allow all cookies",
  "Only allow essential cookies",
  "Accept all",
  "Permite toate modulele cookie",
  "Permite doar modulele cookie esenţiale",
  "Permite doar modulele cookie esențiale",
];

/** aria-labels of the (X) close button inside Facebook dialogs. */
const CLOSE_SELECTOR =
  '[aria-label="Close"], [aria-label="Închide"], [aria-label="Inchide"]';

/**
 * Best-effort dismissal of anything that can cover the page and steal
 * pointer events: cookie consent, notification prompts, promo/e2ee dialogs.
 * Facebook pops these at ANY point in the session — and on a fresh
 * datacenter IP (e.g. Railway) it shows dialogs that never appear locally —
 * so this is called both after page-open and right before clicking UI.
 * Returns true if something was dismissed.
 */
export async function dismissOverlays(page: Page): Promise<boolean> {
  let dismissed = false;

  for (const label of CONSENT_LABELS) {
    try {
      const button = page.getByRole("button", { name: label }).first();
      if (await button.isVisible({ timeout: 300 })) {
        await button.click({ timeout: 2_000 });
        logger.info({ label }, "Answered consent dialog");
        dismissed = true;
        break;
      }
    } catch {
      // Not present — ignore.
    }
  }

  // Generic dialogs (notification prompts, promos, e2ee nags): click their
  // close (X) button when present, otherwise fall back to Escape.
  try {
    const dialogs = page.locator('[role="dialog"]').filter({ visible: true });
    const count = await dialogs.count();
    for (let i = count - 1; i >= 0; i--) {
      const dialog = dialogs.nth(i);
      const text = (await dialog.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 120);
      const close = dialog.locator(CLOSE_SELECTOR).filter({ visible: true }).first();
      if (await close.isVisible({ timeout: 300 }).catch(() => false)) {
        await close.click({ timeout: 2_000 }).catch(() => undefined);
      } else {
        await page.keyboard.press("Escape").catch(() => undefined);
      }
      logger.info({ dialog: text }, "Dismissed blocking dialog");
      dismissed = true;
    }
  } catch {
    // Best-effort — never let dismissal break the session.
  }

  if (dismissed) await page.waitForTimeout(500);
  return dismissed;
}
