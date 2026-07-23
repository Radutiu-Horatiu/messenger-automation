import { type Page } from "playwright";
import { logger } from "../services/logger.js";

/**
 * Perform small, human-like interactions so Facebook doesn't treat the tab
 * as idle. We nudge the mouse and scroll a little, then scroll back. This
 * keeps the session warm without reloading the page.
 */
export function startKeepAlive(page: Page, intervalMin: number): () => void {
  const intervalMs = Math.max(1, intervalMin) * 60_000;

  const tick = async (): Promise<void> => {
    try {
      const x = 200 + Math.floor(Math.random() * 400);
      const y = 200 + Math.floor(Math.random() * 300);
      await page.mouse.move(x, y, { steps: 8 });

      const delta = 120 + Math.floor(Math.random() * 200);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(800 + Math.floor(Math.random() * 700));
      await page.mouse.wheel(0, -delta);

      logger.debug("Keep-alive interaction performed");
    } catch (err) {
      logger.warn({ err }, "Keep-alive interaction failed");
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  logger.info({ intervalMin }, "Keep-alive loop started");
  return () => {
    clearInterval(handle);
    logger.debug("Keep-alive loop stopped");
  };
}
