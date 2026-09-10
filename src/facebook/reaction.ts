import fs from "node:fs/promises";
import path from "node:path";
import { type Page, type Locator } from "playwright";
import { config, type ReactionName } from "../config.js";
import { logger } from "../services/logger.js";
import { dismissOverlays } from "./group.js";

/** aria-label shown on each reaction in the hover fly-out bar. */
const REACTION_ARIA: Record<ReactionName, string> = {
  like: "Like",
  love: "Love",
  care: "Care",
  haha: "Haha",
  wow: "Wow",
  sad: "Sad",
  angry: "Angry",
};

/**
 * Messenger quick-reaction emoji + candidate accessible names.
 * Names include English and Romanian (the user's UI locale) so the
 * aria-label match works regardless of language.
 */
const MESSENGER_REACTION: Record<
  ReactionName,
  { emoji: string; names: string[] }
> = {
  like: { emoji: "👍", names: ["Like", "Îmi place"] },
  love: { emoji: "❤", names: ["Love", "Îmi place la nebunie"] },
  care: { emoji: "🥰", names: ["Care", "Îmi pasă"] },
  haha: { emoji: "😆", names: ["Haha"] },
  wow: { emoji: "😮", names: ["Wow"] },
  sad: { emoji: "😢", names: ["Sad", "Trist", "Întristat"] },
  angry: { emoji: "😡", names: ["Angry", "Furios"] },
};

/** A short, whitespace-normalized snippet used to locate the item by text. */
function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Click a control that a full-screen overlay may be covering. Facebook modals
 * (cookie consent, promos, e2ee nags — frequent on fresh datacenter IPs)
 * intercept pointer events, which Playwright reports as "subtree intercepts
 * pointer events". Dismiss overlays and retry; as a last resort dispatch a
 * DOM click directly on the element, which bypasses hit-testing entirely.
 */
async function clickPastOverlays(page: Page, target: Locator): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await target.click({ timeout: 4_000 });
      return;
    } catch (err) {
      logger.warn(
        { attempt, err: (err as Error).message.split("\n")[0] },
        "Click blocked — dismissing overlays and retrying",
      );
      await dismissOverlays(page);
    }
  }
  await target.dispatchEvent("click");
}

/**
 * Record what the page looked like when a reaction failed on a headless
 * host: any visible dialog's text plus a screenshot in DATA_DIR, so Railway
 * logs/volume show exactly which overlay was in the way.
 */
async function captureFailureDiagnostics(page: Page): Promise<void> {
  try {
    const dialog = page
      .locator('[role="dialog"]')
      .filter({ visible: true })
      .first();
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
      const text = (await dialog.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 200);
      logger.warn({ dialog: text }, "A dialog was covering the page");
    }
    const shot = path.join(config.storage.dataDir, "reaction-failure.png");
    await page.screenshot({ path: shot });
    logger.warn({ screenshot: shot }, "Saved failure screenshot");
  } catch {
    // Diagnostics are best-effort.
  }
}

/**
 * Locate the article element that contains the given text. Facebook renders
 * each post as a role="article" container; we filter by the matched text.
 */
function locateArticle(page: Page, text: string): Locator {
  return page
    .locator('[role="article"]')
    .filter({ hasText: snippetOf(text) })
    .first();
}

/**
 * Save a screenshot of a reaction step when DEBUG_SCREENSHOTS is on, so a
 * run can be replayed frame by frame from data/debug/.
 */
async function debugShot(page: Page, step: string): Promise<void> {
  if (!config.debug.screenshots) return;
  try {
    const dir = path.join(config.storage.dataDir, "debug");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${step}.png`);
    await page.screenshot({ path: file });
    logger.debug({ file }, "Saved debug screenshot");
  } catch {
    // Best-effort.
  }
}

/**
 * Log what the reaction flow could see when it gave up: how many bubbles
 * match the text, which menu buttons and emoji items are on screen. Read with
 * the step logs, it pins down which step's selector no longer fits the page.
 */
async function logReactionContext(page: Page, snippet: string): Promise<void> {
  try {
    const main = page.locator('[role="main"]');
    const bubblesSpan = await main
      .locator('span[dir="auto"]', { hasText: snippet })
      .filter({ visible: true })
      .count();
    const bubblesAny = await main
      .locator('[dir="auto"]', { hasText: snippet })
      .filter({ visible: true })
      .count();
    const menuButtons = await page
      .locator('[aria-haspopup="menu"]')
      .filter({ visible: true })
      .evaluateAll((els) =>
        els.slice(0, 15).map((e) => e.getAttribute("aria-label")),
      );
    const emojiItems = await page
      .locator('[role="menuitemradio"]')
      .filter({ visible: true })
      .evaluateAll((els) =>
        els.map((e) => e.querySelector("img")?.getAttribute("alt") ?? e.textContent),
      );
    logger.warn(
      { snippet, bubblesSpan, bubblesAny, menuButtons, emojiItems },
      "What the reaction flow could see when it failed",
    );
  } catch {
    // Best-effort.
  }
}

/**
 * React to a Messenger message: hover the message row to reveal its action
 * toolbar, click the "React" button, then pick the emoji in the popup.
 * Each step is logged, so a failure names the step it stopped at.
 */
async function reactMessenger(page: Page, text: string): Promise<boolean> {
  const reaction = config.facebook.reaction;
  const { emoji } = MESSENGER_REACTION[reaction];
  const snippet = snippetOf(text);
  const step = (n: number, what: string, extra: Record<string, unknown> = {}): void =>
    logger.info(extra, `React step ${n}/5: ${what}`);

  try {
    // Scope to the OPEN conversation pane so we never touch the left-hand
    // conversation list. The message text renders as a VISIBLE [dir="auto"]
    // span; a separate HIDDEN accessibility span also contains the text, so
    // we must explicitly pick the visible one to hover.
    const main = page.locator('[role="main"]');
    const bubbles = main
      .locator('span[dir="auto"]', { hasText: snippet })
      .filter({ visible: true });
    const bubble = bubbles.last();
    await bubble.waitFor({ state: "visible", timeout: 5_000 });
    await bubble.scrollIntoViewIfNeeded();
    step(1, "found the message bubble", { snippet, matches: await bubbles.count() });

    // Clear any modal (consent, promo, e2ee nag) BEFORE interacting. These
    // show up far more often on server IPs and swallow every real click.
    await dismissOverlays(page);

    // Reveal the action toolbar (React / Reply / More). A physical hover can
    // fail when a Facebook overlay subtree intercepts pointer events, so we
    // dispatch synthetic mouse events on the bubble and let them bubble up to
    // the message row handlers.
    await bubble.dispatchEvent("mouseenter");
    await bubble.dispatchEvent("mouseover", { bubbles: true });
    await page.waitForTimeout(400);
    step(2, "hovered the message to reveal its toolbar");
    await debugShot(page, "2-hovered");

    // React trigger: div[role="button"] with aria-haspopup="menu" whose label
    // contains "emoji" (RO: "Reacţionează cu un emoji"). It lives inside an
    // aria-hidden="true" toolbar, so getByRole would skip it — use a CSS
    // attribute locator instead. The composer's emoji picker ("Alege un
    // emoji") uses haspopup="dialog", so requiring haspopup="menu" avoids it.
    const triggers = page
      .locator('[aria-haspopup="menu"][aria-label*="emoji" i]')
      .filter({ visible: true });
    const reactTrigger = triggers.first();
    await reactTrigger.waitFor({ state: "visible", timeout: 4_000 });
    step(3, "found the react button", {
      candidates: await triggers.count(),
      label: await reactTrigger.getAttribute("aria-label"),
    });
    await clickPastOverlays(page, reactTrigger);

    // Emoji menu: each reaction is a role="menuitemradio" wrapping
    // <img alt="👍">. The container may be aria-hidden, so target the visible
    // menuitemradio directly rather than waiting for the menu wrapper.
    const emojiItem = page
      .locator('[role="menuitemradio"]')
      .filter({ has: page.locator(`img[alt="${emoji}"]`) })
      .filter({ visible: true })
      .first();

    await emojiItem.waitFor({ state: "visible", timeout: 4_000 });
    step(4, "opened the reaction menu");
    await debugShot(page, "4-menu-open");
    try {
      await emojiItem.click({ timeout: 4_000 });
    } catch {
      // The menu is open but something still covers it — don't press Escape
      // (it would close the menu); dispatch the click directly instead.
      await emojiItem.dispatchEvent("click");
    }
    step(5, `clicked ${emoji}`);
    await page.waitForTimeout(800);
    await debugShot(page, "5-reacted");
    logger.info({ reaction, emoji }, "Applied Messenger reaction");
    return true;
  } catch (err) {
    logger.error(
      { err: (err as Error).message.split("\n")[0], reaction },
      "Failed to apply Messenger reaction — selectors may need tuning",
    );
    await logReactionContext(page, snippet);
    await captureFailureDiagnostics(page);
    return false;
  }
}

/**
 * Apply the configured reaction to the group post containing `text`.
 */
async function reactGroup(page: Page, text: string): Promise<boolean> {
  const article = locateArticle(page, text);
  const reaction = config.facebook.reaction;

  try {
    await article.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await dismissOverlays(page);

    // The toggle button labeled "Like" lives inside each article's footer.
    const likeButton = article
      .getByRole("button", { name: REACTION_ARIA.like })
      .first();

    await likeButton.waitFor({ state: "visible", timeout: 8_000 });

    if (reaction === "like") {
      await clickPastOverlays(page, likeButton);
      logger.info("Applied reaction: like");
      return true;
    }

    // Hover to open the reaction fly-out, then pick the specific reaction.
    await likeButton.hover();
    await page.waitForTimeout(1_200);

    const target = REACTION_ARIA[reaction];
    const reactionButton = page
      .getByRole("button", { name: target, exact: true })
      .or(page.locator(`[aria-label="${target}"]`))
      .first();

    await reactionButton.waitFor({ state: "visible", timeout: 5_000 });
    await reactionButton.click({ timeout: 5_000 });
    logger.info({ reaction }, "Applied reaction");
    return true;
  } catch (err) {
    logger.error({ err, reaction }, "Failed to apply reaction");
    await captureFailureDiagnostics(page);
    return false;
  }
}

/**
 * Apply the configured reaction to the item containing `text`, dispatching
 * to the group- or Messenger-specific implementation based on platform.
 */
export async function react(page: Page, text: string): Promise<boolean> {
  if (config.facebook.platform === "messenger") {
    return reactMessenger(page, text);
  }
  return reactGroup(page, text);
}
