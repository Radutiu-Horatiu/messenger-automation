import "dotenv/config";
import path from "node:path";

export type MatchMode = "exact" | "includes" | "startsWith";
export type Platform = "group" | "messenger";
export type ReactionName =
  | "like"
  | "love"
  | "care"
  | "haha"
  | "wow"
  | "sad"
  | "angry";

const VALID_REACTIONS: ReactionName[] = [
  "like",
  "love",
  "care",
  "haha",
  "wow",
  "sad",
  "angry",
];

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** An integer env var that is genuinely optional (null when unset/invalid). */
function optionalInteger(name: string): number | null {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const dataDir = optional("DATA_DIR", path.resolve("data"));

const matchModeRaw = optional("MATCH_MODE", "includes").toLowerCase();
const matchMode: MatchMode =
  matchModeRaw === "exact"
    ? "exact"
    : matchModeRaw === "startswith"
      ? "startsWith"
      : "includes";

const reactionRaw = optional("REACTION", "like").toLowerCase() as ReactionName;
const reaction: ReactionName = VALID_REACTIONS.includes(reactionRaw)
  ? reactionRaw
  : "like";

const groupUrl = required("FB_GROUP_URL");

// Auto-detect the platform from the URL; allow an explicit PLATFORM override.
const platformRaw = optional("PLATFORM", "").toLowerCase();
const platform: Platform =
  platformRaw === "messenger"
    ? "messenger"
    : platformRaw === "group"
      ? "group"
      : groupUrl.includes("/messages/")
        ? "messenger"
        : "group";

export const config = {
  facebook: {
    groupUrl,
    platform,
    targetText: required("TARGET_TEXT"),
    matchMode,
    reaction,
  },
  schedule: {
    startCron: optional("START_CRON", "0 10 * * 0"),
    stopHour: integer("STOP_HOUR", 22),
    // Only used for one-shot runs (RUN_ONCE / --once). Platform cron
    // schedulers such as Railway's evaluate expressions in UTC only, so a
    // fixed UTC trigger drifts by an hour across DST. Set START_HOUR to the
    // intended LOCAL hour and point the platform cron at the earliest UTC
    // time it can occur; the process then sleeps until that local hour before
    // opening the browser. Unset = start immediately.
    startHour: optionalInteger("START_HOUR"),
    // Hard cap on how long a single session may stay open, regardless of
    // STOP_HOUR. Mainly a testing lever: with a fast START_CRON, a session
    // that finds no target message would otherwise hold the slot until
    // STOP_HOUR and every later trigger would be skipped as "already
    // running". Unset = bounded only by STOP_HOUR.
    maxSessionMin: optionalInteger("MAX_SESSION_MIN"),
    timezone: optional("TZ", "UTC"),
    // End the session as soon as one target message is successfully reacted to.
    // Useful for weekly "wake up, react, go back to sleep" deployments.
    exitAfterReact: boolean("EXIT_AFTER_REACT", false),
  },
  storage: {
    dataDir,
    storageStatePath: optional(
      "STORAGE_STATE_PATH",
      path.join(dataDir, "storageState.json"),
    ),
    profileDir: optional("PROFILE_DIR", path.join(dataDir, "facebook-profile")),
    reactedDbPath: optional("REACTED_DB_PATH", path.join(dataDir, "reacted.json")),
    // Base64 of a storageState.json, for hosts where dropping a file onto a
    // volume is awkward. Treated as a fresh push: whenever its content differs
    // from the last one imported, it overwrites the file on disk. Otherwise
    // the on-disk copy wins, because healthy runs keep refreshing it.
    storageStateB64: optional("FB_STORAGE_STATE_B64", ""),
    // Records which FB_STORAGE_STATE_B64 value we last imported.
    storageStateSourcePath: path.join(dataDir, ".storage-state-source"),
  },
  browser: {
    headless: boolean("HEADLESS", true),
    keepAliveIntervalMin: integer("KEEPALIVE_INTERVAL_MIN", 3),
  },
  notifications: {
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL", ""),
  },
  logging: {
    level: optional("LOG_LEVEL", "info"),
  },
  debug: {
    // React to matching messages that are ALREADY on screen at startup
    // (useful for testing). Default false = only new incoming messages.
    reactToExisting: boolean("REACT_TO_EXISTING", false),
    // Forward the browser console + diagnostics into the Node logs.
    verbose: boolean("VERBOSE", false),
  },
} as const;

export type AppConfig = typeof config;
