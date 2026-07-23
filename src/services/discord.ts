import { config } from "../config.js";
import { logger } from "./logger.js";

type NotifyLevel = "success" | "error" | "info";

const EMOJI: Record<NotifyLevel, string> = {
  success: "✅",
  error: "❌",
  info: "ℹ️",
};

/**
 * Send a message to the configured Discord webhook.
 * No-ops silently (with a debug log) when no webhook is configured.
 */
export async function notify(
  level: NotifyLevel,
  message: string,
): Promise<void> {
  const url = config.notifications.discordWebhookUrl;
  if (!url) {
    logger.debug({ message }, "Discord webhook not configured; skipping notify");
    return;
  }

  const content = `${EMOJI[level]} ${message}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "Discord webhook returned non-OK status",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to send Discord notification");
  }
}
