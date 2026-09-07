import { type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { notify } from "../services/discord.js";

/**
 * Decide whether Facebook is refusing this session, returning a human-readable
 * reason or null when we look logged in.
 *
 * URL heuristics catch the outright redirects. The visible password field
 * catches the "we still remember your account, prove it's you" screen, which
 * Facebook can render without any of the tell-tale URLs — that one previously
 * read as a valid session and failed later with a confusing selector error.
 */
export async function detectLoggedOut(page: Page): Promise<string | null> {
  const url = page.url();
  if (url.includes("/login") || url.includes("login.php")) {
    return `redirected to the login page (${url})`;
  }
  if (url.includes("/checkpoint")) {
    return `hit a security checkpoint (${url})`;
  }

  const passwordField = page
    .locator('input[type="password"]')
    .filter({ visible: true })
    .first();
  if (await passwordField.isVisible({ timeout: 1_000 }).catch(() => false)) {
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
    await notify(
      "error",
      `Facebook session expired — ${loggedOutReason}. Run \`npm run login\` locally and update FB_STORAGE_STATE_B64.`,
    );
    throw new Error(`Session expired; ${loggedOutReason}`);
  }

  await dismissOverlays(page);
  logger.info("Group feed is open and session looks valid");
  return page;
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
