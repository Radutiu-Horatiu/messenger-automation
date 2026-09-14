import { type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { logger } from "./logger.js";
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
 * How long a session may run — until STOP_HOUR, or for MAX_SESSION_MIN if that
 * comes first — and which of the two is the limit, for the logs.
 */
function sessionBudget(): { ms: number; boundedBy: string } {
  const stopHourMs = msUntilLocalHour(config.schedule.stopHour, "tomorrow");
  const { maxSessionMin, stopHour } = config.schedule;
  if (maxSessionMin !== null && maxSessionMin * 60_000 < stopHourMs) {
    return { ms: maxSessionMin * 60_000, boundedBy: `MAX_SESSION_MIN=${maxSessionMin}` };
  }
  return { ms: stopHourMs, boundedBy: `STOP_HOUR=${stopHour}` };
}

/** Wall-clock time in the configured zone, e.g. "14:52:07". */
function localTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", {
    timeZone: config.schedule.timezone,
  });
}

/** First wait after a failed page-open; doubles each time up to the cap. */
const OPEN_RETRY_INITIAL_MS = 30_000;
const OPEN_RETRY_MAX_MS = 15 * 60_000;
/** Roughly what one open attempt costs: navigation, settle time, checks. */
const OPEN_ATTEMPT_MS = 20_000;

/**
 * Open the conversation, retrying until it works or the session window runs
 * out. Returns null when time is up.
 *
 * A single failed open used to end the whole run, so one slow load, stray
 * redirect or security checkpoint forfeited the day. Retrying also gives a
 * checkpoint the chance to clear: approving Facebook's "was this you?" prompt
 * on your phone lets the next attempt through. The backoff stops a session
 * that is genuinely dead from reloading Facebook every few seconds from a
 * datacenter IP, which would only deepen Facebook's suspicion.
 */
async function openGroupUntil(
  context: BrowserContext,
  deadline: number,
): Promise<Page | null> {
  let delayMs = OPEN_RETRY_INITIAL_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await openGroup(context);
    } catch (err) {
      const remainingMs = deadline - Date.now();
      const canRetry = remainingMs > delayMs + OPEN_ATTEMPT_MS;
      logger.warn(
        {
          attempt,
          retryInSec: canRetry ? Math.round(delayMs / 1000) : null,
          secondsLeft: Math.round(remainingMs / 1000),
        },
        `Could not open the conversation: ${(err as Error).message.split("\n")[0]}`,
      );
      if (!canRetry) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, OPEN_RETRY_MAX_MS);
    }
  }
}

/**
 * How a session ended. `ok: false` means something needs your attention — the
 * session is dead, a matching message could not be reacted to, or the run
 * crashed. A window that closes because nobody posted is a normal Sunday, not
 * a failure.
 */
export interface SessionOutcome {
  ok: boolean;
  summary: string;
}

/**
 * Run one session:
 *  - launch the persistent browser
 *  - open the conversation, retrying until it opens or time runs out
 *  - attach the MutationObserver and react to matching messages
 *  - keep listening until a reaction succeeds (when exitAfterReact) or the
 *    window closes, then shut down
 */
export async function runSession(
  exitAfterReact = false,
): Promise<SessionOutcome> {
  // The window closes at one fixed moment, decided up front, so retries and
  // listening draw on a single budget: however the time gets spent, a run
  // never outlives MAX_SESSION_MIN / STOP_HOUR.
  //
  // Times and limits go in the message text, not just in fields: Railway's
  // log view shows only the text, so a window that ended on schedule looked
  // like the job dying "for some reason".
  const budget = sessionBudget();
  const deadline = Date.now() + budget.ms;
  const endsAt = localTime(deadline);
  logger.info(
    `Session starting — window closes at ${endsAt} (${budget.boundedBy})`,
  );

  const context = await launchContext();
  let stopKeepAlive: (() => void) | null = null;
  let stopObserver: (() => void) | null = null;
  // Set once we have confirmed a logged-in page; gates the cookie write-back.
  let sessionHealthy = false;
  let result: SessionOutcome = { ok: false, summary: "the session ended unexpectedly" };

  try {
    const page = await openGroupUntil(context, deadline);
    if (!page) {
      logger.error(
        "Gave up: the conversation never opened before the session window closed — the attempts above say why",
      );
      result = {
        ok: false,
        summary:
          "the conversation never opened — most likely the Facebook session is dead; run `npm run login:host` and update FB_STORAGE_STATE_B64",
      };
      return result;
    }
    sessionHealthy = true;

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
    let matchedCount = 0;
    let reactedCount = 0;
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
        reactedCount++;
        logger.info({ postId: post.id }, "Reaction successful");
        if (exitAfterReact && resolveReactionDone) {
          resolveReactionDone();
          resolveReactionDone = null;
        }
      } else {
        logger.warn(
          { postId: post.id },
          "Matched a message but could not react — still listening for the next one",
        );
      }
    };

    const handlePost = (post: DetectedPost): void => {
      const matched = matchesTarget(post.text);
      logger.debug(
        { postId: post.id, matched, text: post.text.slice(0, 120) },
        "Message received",
      );
      if (!matched) return;
      matchedCount++;

      // Always keep the latest match; reset the timer on every new one.
      pendingPost = post;
      if (reactionTimeout) clearTimeout(reactionTimeout);
      reactionTimeout = setTimeout(() => {
        reactionQueue = reactionQueue
          .then(flushReaction)
          .catch((err) => logger.error({ err }, "Reaction queue failed"));
      }, 800);
    };

    stopObserver = await attachObserver(page, handlePost);
    stopKeepAlive = startKeepAlive(page, config.browser.keepAliveIntervalMin);

    const waitMs = Math.max(0, deadline - Date.now());
    const target = `"${config.facebook.targetText}"`;
    logger.info(
      exitAfterReact
        ? `Listening for a new ${target} message until ${endsAt} — a reaction ends it sooner`
        : `Listening for new ${target} messages until ${endsAt}`,
    );

    let outcome: "reacted" | "window-closed" = "window-closed";
    if (exitAfterReact) {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          new Promise<"window-closed">((resolve) => {
            stopTimer = setTimeout(() => resolve("window-closed"), waitMs);
          }),
          reactionDone.then(() => "reacted" as const),
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

    if (outcome === "window-closed") {
      logger.info(
        matchedCount === 0
          ? `Window closed at ${endsAt} (${budget.boundedBy}) — no new ${target} message arrived while listening`
          : `Window closed at ${endsAt} (${budget.boundedBy}) — ${matchedCount} matching message(s) arrived but no reaction succeeded; see the React step lines above`,
      );
    }

    if (reactedCount > 0) {
      result = { ok: true, summary: `reacted to ${target}` };
    } else if (matchedCount > 0) {
      result = {
        ok: false,
        summary: `${matchedCount} ${target} message(s) arrived but the reaction failed — see the React step lines above`,
      };
    } else {
      result = { ok: true, summary: `no new ${target} message arrived before ${endsAt}` };
    }
  } catch (err) {
    const message = (err as Error).message.split("\n")[0];
    logger.error({ err }, `Session error: ${message}`);
    result = { ok: false, summary: `session error: ${message}` };
  } finally {
    stopKeepAlive?.();
    stopObserver?.();
    logger.info("Stopping — closing browser");
    // Only persist cookies from a session we know was logged in. If openGroup
    // threw because Facebook bounced us to a login/checkpoint page, the
    // context now holds logged-out cookies, and writing those would overwrite
    // the last known-good storageState.json — turning a recoverable blip into
    // a mandatory manual re-login.
    if (sessionHealthy) {
      await saveStorageState(context).catch(() => undefined);
    } else {
      logger.warn(
        "Session was not healthy — keeping the previous storageState.json instead of overwriting it",
      );
    }
    await context.close().catch(() => undefined);
  }
  return result;
}
