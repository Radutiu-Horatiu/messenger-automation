import { type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { notify } from "../services/discord.js";

/** Heuristics that indicate we've been bounced to a login/checkpoint page. */
function looksLoggedOut(url: string): boolean {
  return (
    url.includes("/login") ||
    url.includes("login.php") ||
    url.includes("/checkpoint")
  );
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
  const currentUrl = page.url();
  if (looksLoggedOut(currentUrl)) {
    await notify("error", "Facebook session expired — please re-login locally.");
    throw new Error(`Session expired; redirected to ${currentUrl}`);
  }

  await dismissDialogs(page);
  logger.info("Group feed is open and session looks valid");
  return page;
}

/** Best-effort dismissal of cookie banners / notification prompts. */
async function dismissDialogs(page: Page): Promise<void> {
  const labels = [
    "Allow all cookies",
    "Only allow essential cookies",
    "Accept all",
    "Close",
    "Not now",
  ];
  for (const label of labels) {
    try {
      const button = page.getByRole("button", { name: label }).first();
      if (await button.isVisible({ timeout: 1_000 })) {
        await button.click({ timeout: 2_000 });
        logger.debug({ label }, "Dismissed dialog");
      }
    } catch {
      // Not present — ignore.
    }
  }
}
