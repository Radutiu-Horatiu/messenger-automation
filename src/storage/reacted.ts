import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../services/logger.js";

/**
 * Persistent record of posts we've already reacted to.
 * Keyed by a stable post identifier (or a date bucket) so we never
 * react to the same message twice, even across redeployments.
 *
 * Example on disk:
 * {
 *   "2026-07-19": true,
 *   "post:pfbid02abc...": true
 * }
 */
type ReactedMap = Record<string, boolean>;

let cache: ReactedMap | null = null;

async function ensureDir(): Promise<void> {
  const dir = path.dirname(config.storage.reactedDbPath);
  await fs.mkdir(dir, { recursive: true });
}

async function load(): Promise<ReactedMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(config.storage.reactedDbPath, "utf8");
    cache = JSON.parse(raw) as ReactedMap;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err }, "Failed reading reacted DB; starting fresh");
    }
    cache = {};
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await ensureDir();
  await fs.writeFile(
    config.storage.reactedDbPath,
    JSON.stringify(cache, null, 2),
    "utf8",
  );
}

export async function hasReacted(key: string): Promise<boolean> {
  const map = await load();
  return map[key] === true;
}

export async function markReacted(key: string): Promise<void> {
  const map = await load();
  map[key] = true;
  await persist();
  logger.debug({ key }, "Marked post as reacted");
}

/** The daily bucket key, e.g. "2026-07-19". Useful as a coarse dedupe guard. */
export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
