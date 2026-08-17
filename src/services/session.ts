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

/**
 * Milliseconds until `hour`:00 local time (local = the TZ env var, which Node
 * honours for Date). When today's occurrence has already passed, `ifPast`
 * decides what to do:
 *  - "tomorrow": roll over to tomorrow — used for the stop hour so a session
 *    started in the evening still gets a full window instead of exiting at once.
 *  - "now": return 0 — used for the start hour so a trigger that fires late
 *    begins immediately rather than sleeping almost a full day.
 */
function msUntilLocalHour(hour: number, ifPast: "tomorrow" | "now"): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    if (ifPast === "now") return 0;
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Sleep until START_HOUR local time, if configured and still ahead of us.
 *
 * This exists for one-shot runs driven by a platform cron that only supports
 * UTC (Railway). Point that cron at the earliest UTC time the local hour can
 * occur and the process idles here — cheaply, before Chromium launches — until
 * the wall-clock hour is right, so the schedule survives DST changes.
 */
export async function waitUntilStartHour(): Promise<void> {
  const { startHour, timezone } = config.schedule;
  if (startHour === null) return;

  const waitMs = msUntilLocalHour(startHour, "now");
  if (waitMs === 0) {
    logger.info(
      { startHour, timezone },
      "START_HOUR already reached — starting session now",
    );
    return;
  }

  logger.info(
    { startHour, timezone, waitMinutes: Math.round(waitMs / 60_000) },
    "Triggered before START_HOUR — sleeping until the local start hour",
  );
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
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

    const waitMs = msUntilLocalHour(config.schedule.stopHour, "tomorrow");
    logger.info(
      { stopHour: config.schedule.stopHour, waitMinutes: Math.round(waitMs / 60000) },
      "Session running until stop hour",
    );

    if (exitAfterReact) {
      logger.info(
        "EXIT_AFTER_REACT enabled — session will close after the first successful reaction",
      );
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            stopTimer = setTimeout(resolve, waitMs);
          }),
          reactionDone,
        ]);
      } finally {
        // The losing side of the race leaves a pending timer worth up to a
        // full day. Node keeps the event loop alive while it exists, so
        // without this a one-shot run would not exit until STOP_HOUR — the
        // container would sit there, billed, long after the work was done.
        clearTimeout(stopTimer);
      }
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
