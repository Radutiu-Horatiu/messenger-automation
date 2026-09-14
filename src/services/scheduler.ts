import cron from "node-cron";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { runSession } from "./session.js";

let running = false;

async function guardedRun(): Promise<void> {
  if (running) {
    logger.warn("A session is already running — skipping this trigger");
    return;
  }
  running = true;
  try {
    // Always-on mode cannot signal failure by exiting (the process must stay
    // up for the next trigger), so the log line is the only record here.
    const outcome = await runSession(config.schedule.exitAfterReact);
    if (outcome.ok) logger.info(`Run finished — ${outcome.summary}`);
    else logger.error(`RUN FAILED — ${outcome.summary}`);
  } finally {
    running = false;
  }
}

/**
 * Register the cron trigger that starts a daily session. The session itself
 * decides when to stop (STOP_HOUR), so cron only needs to fire the start.
 */
export function startScheduler(): void {
  const { startCron, timezone } = config.schedule;

  if (!cron.validate(startCron)) {
    throw new Error(`Invalid START_CRON expression: "${startCron}"`);
  }

  cron.schedule(
    startCron,
    () => {
      logger.info({ startCron }, "Cron fired — launching session");
      void guardedRun();
    },
    { timezone },
  );

  logger.info(
    { startCron, timezone, stopHour: config.schedule.stopHour },
    "Scheduler registered — waiting for next trigger",
  );
}
