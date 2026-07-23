import { type Page, type Locator } from "playwright";
import { config, type ReactionName } from "../config.js";
import { logger } from "../services/logger.js";

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
 * React to a Messenger message: hover the message row to reveal its action
 * toolbar, click the "React" button, then pick the emoji in the popup.
 */
async function reactMessenger(page: Page, text: string): Promise<boolean> {
  const reaction = config.facebook.reaction;
  const { emoji } = MESSENGER_REACTION[reaction];
  const snippet = snippetOf(text);

  try {
    // Scope to the OPEN conversation pane so we never touch the left-hand
    // conversation list. The message text renders as a VISIBLE [dir="auto"]
    // span; a separate HIDDEN accessibility span also contains the text, so
    // we must explicitly pick the visible one to hover.
    const main = page.locator('[role="main"]');
    const bubble = main
      .locator('span[dir="auto"]', { hasText: snippet })
      .filter({ visible: true })
      .last();
    await bubble.waitFor({ state: "visible", timeout: 5_000 });
    await bubble.scrollIntoViewIfNeeded();

    // Hovering the message reveals its action toolbar (React / Reply / More).
    await bubble.hover();
    await page.waitForTimeout(400);

    // React trigger: div[role="button"] with aria-haspopup="menu" whose label
    // contains "emoji" (RO: "Reacţionează cu un emoji"). It lives inside an
    // aria-hidden="true" toolbar, so getByRole would skip it — use a CSS
    // attribute locator instead. The composer's emoji picker ("Alege un
    // emoji") uses haspopup="dialog", so requiring haspopup="menu" avoids it.
    const reactTrigger = page
      .locator('[aria-haspopup="menu"][aria-label*="emoji" i]')
      .filter({ visible: true })
      .first();
    await reactTrigger.waitFor({ state: "visible", timeout: 4_000 });
    await reactTrigger.click({ timeout: 4_000 });

    // Emoji menu: each reaction is a role="menuitemradio" wrapping
    // <img alt="👍">. The container may be aria-hidden, so target the visible
    // menuitemradio directly rather than waiting for the menu wrapper.
    const emojiItem = page
      .locator('[role="menuitemradio"]')
      .filter({ has: page.locator(`img[alt="${emoji}"]`) })
      .filter({ visible: true })
      .first();

    await emojiItem.waitFor({ state: "visible", timeout: 4_000 });
    await emojiItem.click({ timeout: 4_000 });
    logger.info({ reaction, emoji }, "Applied Messenger reaction");
    return true;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, reaction },
      "Failed to apply Messenger reaction — selectors may need tuning",
    );
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

    // The toggle button labeled "Like" lives inside each article's footer.
    const likeButton = article
      .getByRole("button", { name: REACTION_ARIA.like })
      .first();

    await likeButton.waitFor({ state: "visible", timeout: 8_000 });

    if (reaction === "like") {
      await likeButton.click({ timeout: 5_000 });
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
