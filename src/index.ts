import { config } from "./config.js";
import { logger } from "./services/logger.js";
import { startScheduler } from "./services/scheduler.js";
import { runSession } from "./services/session.js";

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
    await runSession(true);
    logger.info("Single session complete — exiting");
    return;
  }

  startScheduler();
  // Keep the process alive for the always-on service.
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
