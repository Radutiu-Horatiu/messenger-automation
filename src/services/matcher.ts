import { config } from "../config.js";

/**
 * Normalize text for tolerant, case-insensitive comparisons:
 *  - lowercase
 *  - collapse runs of whitespace to a single space
 *  - drop whitespace that sits directly before punctuation
 *    (so "marti ?" and "Marti ?" both become "marti?")
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+([?!.,;:])/g, "$1")
    .trim();
}

/**
 * Decide whether a post's text matches the configured target,
 * honoring MATCH_MODE:
 *   - "exact":      normalized text equals the target
 *   - "includes":   normalized text contains the target anywhere
 *   - "startsWith": normalized text begins with the target
 *
 * Example: TARGET_TEXT="Marti?" with MATCH_MODE="startsWith" matches
 * "marti?", "Marti ?", "marti ?" (message must begin with it).
 */
export function matchesTarget(postText: string): boolean {
  const haystack = normalize(postText);
  const needle = normalize(config.facebook.targetText);
  if (needle === "") return false;

  switch (config.facebook.matchMode) {
    case "exact":
      return haystack === needle;
    case "startsWith":
      return haystack.startsWith(needle);
    case "includes":
    default:
      return haystack.includes(needle);
  }
}
