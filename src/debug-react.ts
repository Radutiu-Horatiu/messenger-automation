/**
 * LOCAL REACTION DEBUG RUN
 * ------------------------
 *   npm run debug:react -- https://www.facebook.com/messages/t/<conversation-id>
 *
 * One visible, fully logged session against the given conversation: it listens
 * for up to 10 minutes and stops as soon as it reacts. You see every message
 * the observer picks up and whether it matched TARGET_TEXT, an observer health
 * line every 30s, and each of the five reaction steps — with a screenshot per
 * step in data/debug/.
 *
 * Send the test message from ANOTHER device or account once the log says
 * "Listening". Typing it into the bot's own window would put the text in the
 * composer, not in the chat.
 *
 * Anything set in the shell still wins over these defaults; .env supplies the
 * rest (TARGET_TEXT, MATCH_MODE, REACTION, …).
 */
export {};

const url = process.argv[2];
if (url) process.env.FB_GROUP_URL = url;

process.env.RUN_ONCE ??= "true";
process.env.HEADLESS ??= "false";
process.env.LOG_LEVEL ??= "debug";
process.env.MAX_SESSION_MIN ??= "10";
process.env.DEBUG_SCREENSHOTS ??= "true";
process.env.REACT_TO_EXISTING ??= "false";
// Never sleep until a scheduled local hour in a debug run.
process.env.START_HOUR ??= "";

if (!url) {
  console.warn(
    "\n  No conversation URL given — falling back to FB_GROUP_URL from .env." +
      "\n  Usage: npm run debug:react -- https://www.facebook.com/messages/t/<id>\n",
  );
}

// Imported only after the environment is set: config reads it at import time,
// and dotenv never overrides a variable that is already set.
await import("./index.js");
