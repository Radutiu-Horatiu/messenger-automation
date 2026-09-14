import { config } from "./config.js";
import { logger } from "./services/logger.js";
import { startScheduler } from "./services/scheduler.js";
import { runSession, waitUntilStartHour } from "./services/session.js";

/**
 * Entrypoint.
 *  - Default: register the cron scheduler and stay alive.
 *  - `--once`: run a single session immediately (useful for local testing
 *    and Railway "cron" style one-shot deploys).
 */
async function main(): Promise<void> {
  const runOnce =
    process.argv.includes("--once") || process.env.RUN_ONCE === "true";

  logger.info(
    {
      group: config.facebook.groupUrl,
      target: config.facebook.targetText,
      matchMode: config.facebook.matchMode,
      reaction: config.facebook.reaction,
      mode: runOnce ? "once" : "scheduled",
    },
    "messenger-automation starting",
  );

  if (runOnce) {
    // Honour START_HOUR so a UTC-only platform cron can still land on the
    // right local hour year-round.
    await waitUntilStartHour();
    const outcome = await runSession(true);
    if (outcome.ok) {
      logger.info(`Run finished — ${outcome.summary}`);
    } else {
      // A non-zero exit is the alert: Railway marks the run Crashed and emails
      // the project's members. Keep the service's Restart Policy at Never —
      // any retrying policy turns one failure into a burst of reruns.
      process.exitCode = 1;
      logger.error(
        `RUN FAILED — ${outcome.summary}. Exiting with an error so Railway flags this run and emails you.`,
      );
    }
    scheduleForcedExit();
    return;
  }

  startScheduler();
  // Keep the process alive for the always-on service.
}

/**
 * Under a platform cron, billing runs until the process exits, so a stray
 * handle is expensive rather than merely untidy. The event loop should drain
 * on its own; this is a backstop that fires only if it doesn't. `unref()`
 * keeps the backstop itself from being the thing that holds the loop open.
 */
function scheduleForcedExit(): void {
  const timer = setTimeout(() => {
    logger.warn("Event loop still active after session — forcing exit");
    // No argument: keep the exit code the run decided on. process.exit(0)
    // here would silently turn a failed run into a successful one.
    process.exit();
  }, 5_000);
  timer.unref();
}

function installSignalHandlers(): void {
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Received shutdown signal — exiting");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

installSignalHandlers();
main().catch((err) => {
  logger.error({ err }, "Fatal error in main");
  process.exit(1);
});
