import { config } from "../config.js";
import { logger } from "./logger.js";
import { notify } from "./discord.js";
import { matchesTarget } from "./matcher.js";
import { launchContext, saveStorageState } from "../facebook/browser.js";
import { openGroup } from "../facebook/group.js";
import { attachObserver, type DetectedPost } from "../facebook/observer.js";
import { react } from "../facebook/reaction.js";
import { startKeepAlive } from "../facebook/keepalive.js";
import { hasReacted, markReacted } from "../storage/reacted.js";

/** Milliseconds until the next occurrence of STOP_HOUR:00 local time. */
function msUntilStopHour(stopHour: number): number {
  const now = new Date();
  const stop = new Date(now);
  stop.setHours(stopHour, 0, 0, 0);
  if (stop.getTime() <= now.getTime()) {
    // Already past today's stop hour — run a short session (avoid instant exit).
    stop.setDate(stop.getDate() + 1);
  }
  return stop.getTime() - now.getTime();
}

/**
 * Run one full daily session:
 *  - launch persistent browser
 *  - open the group and verify the session
 *  - attach the MutationObserver
 *  - react to matching posts (deduped)
 *  - keep the tab warm until STOP_HOUR, then shut down
 */
export async function runSession(exitAfterReact = false): Promise<void> {
  logger.info("Browser started");
  await notify("info", "Bot session started — watching group.");

  const context = await launchContext();
  let stopKeepAlive: (() => void) | null = null;

  try {
    const page = await openGroup(context);

    // Forward browser-side console + page errors into our logs so we can see
    // exactly what the injected observer is doing.
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[mautomation]")) {
        logger.debug({ browser: true }, text);
      } else if (config.debug.verbose) {
        logger.debug({ browser: true, type: msg.type() }, text);
      }
    });
    page.on("pageerror", (err) => {
      logger.warn({ err: err.message }, "Browser page error");
    });

    // Debounce matching messages and only react to the latest one in a burst.
    // This way if several "marti?" messages arrive quickly, only the last
    // one gets liked, and re-running the bot won't toggle the reaction on/off.
    let reactionQueue = Promise.resolve();
    let pendingPost: DetectedPost | null = null;
    let reactionTimeout: ReturnType<typeof setTimeout> | null = null;
    let resolveReactionDone: (() => void) | null = null;
    const reactionDone = new Promise<void>((resolve) => {
      resolveReactionDone = resolve;
    });

    const flushReaction = async (): Promise<void> => {
      const post = pendingPost;
      pendingPost = null;
      if (!post) return;

      if (await hasReacted(post.id)) {
        logger.info({ postId: post.id }, "Already reacted — skipping");
        return;
      }

      logger.info({ postId: post.id }, "Target message detected");
      const ok = await react(page, post.text);
      if (ok) {
        await markReacted(post.id);
        await saveStorageState(context);
        logger.info({ postId: post.id }, "Reaction successful");
        await notify(
          "success",
          `Reacted (${config.facebook.reaction}) to "${config.facebook.targetText}".`,
        );
        if (exitAfterReact && resolveReactionDone) {
          resolveReactionDone();
          resolveReactionDone = null;
        }
      } else {
        await notify("error", "Matched a post but failed to react.");
      }
    };

    const handlePost = (post: DetectedPost): void => {
      const matched = matchesTarget(post.text);
      logger.debug(
        { postId: post.id, matched, text: post.text.slice(0, 120) },
        "Message received",
      );
      if (!matched) return;

      // Always keep the latest match; reset the timer on every new one.
      pendingPost = post;
      if (reactionTimeout) clearTimeout(reactionTimeout);
      reactionTimeout = setTimeout(() => {
        reactionQueue = reactionQueue
          .then(flushReaction)
          .catch((err) => logger.error({ err }, "Reaction queue failed"));
      }, 800);
    };

    await attachObserver(page, handlePost);
    stopKeepAlive = startKeepAlive(page, config.browser.keepAliveIntervalMin);

    const waitMs = msUntilStopHour(config.schedule.stopHour);
    logger.info(
      { stopHour: config.schedule.stopHour, waitMinutes: Math.round(waitMs / 60000) },
      "Session running until stop hour",
    );

    if (exitAfterReact) {
      logger.info(
        "EXIT_AFTER_REACT enabled — session will close after the first successful reaction",
      );
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
        reactionDone,
      ]);
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  } catch (err) {
    logger.error({ err }, "Session error");
    await notify("error", `Session error: ${(err as Error).message}`);
  } finally {
    stopKeepAlive?.();
    logger.info("Stopping — closing browser");
    await saveStorageState(context).catch(() => undefined);
    await context.close().catch(() => undefined);
    await notify("info", "Bot session stopped.");
  }
}
