import { type Page } from "playwright";
import { config, type Platform } from "../config.js";
import { logger } from "../services/logger.js";

export interface DetectedPost {
  /** A stable-ish identifier for the post (pfbid, permalink, or text hash). */
  id: string;
  /** Full visible text of the post. */
  text: string;
}

export type PostHandler = (post: DetectedPost) => void | Promise<void>;

const BINDING_NAME = "__onFacebookPost";
/** How often Node checks that the in-page observer is still alive. */
const WATCHDOG_MS = 20_000;
/** How often the in-page observer reports its own health to the logs. */
const HEARTBEAT_MS = 30_000;

interface InstallOptions {
  bindingName: string;
  platform: Platform;
  /** Emit messages already on screen (testing). Ignored on re-attach. */
  reactToExisting: boolean;
  /** False when re-attaching after the observer was lost. */
  initial: boolean;
  heartbeatMs: number;
}

/**
 * The in-page half: a MutationObserver that reports each new message to Node
 * through the exposed binding. It runs inside the browser, so it must be fully
 * self-contained. Running it again replaces the previous instance, which is
 * how the watchdog re-attaches after a reload or re-render.
 */
function installObserver(opts: InstallOptions): void {
  const { bindingName, platform, reactToExisting, initial, heartbeatMs } = opts;
  const w = window as unknown as Record<string, any>;
  const emit = w[bindingName] as (p: { id: string; text: string }) => void;

  // Retire the previous instance, if this is a re-attach.
  w.__mautomationObserver?.disconnect();
  clearInterval(w.__mautomationHeartbeat);

  const SEEN_ATTR = "data-mautomation-seen";
  const ID_ATTR = "data-mautomation-id";
  // Group posts render as [role="article"]. Messenger messages in the open
  // thread are plain [dir="auto"] text nodes.
  const ITEM_SELECTOR =
    platform === "messenger" ? '[dir="auto"]' : '[role="article"]';

  let msgCounter = 0;
  let detected = 0;
  let mutationsSeen = 0;

  function hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return `text:${hash}`;
  }

  function generateMessengerId(item: HTMLElement): string {
    let id = item.getAttribute(ID_ATTR);
    if (id) return id;
    id = `mmsg:${Date.now()}:${++msgCounter}:${hashText(
      (item.innerText || "").trim(),
    )}`;
    item.setAttribute(ID_ATTR, id);
    return id;
  }

  function extractGroupId(article: HTMLElement, text: string): string {
    const links = Array.from(article.querySelectorAll("a[href]"));
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      const m =
        href.match(/pfbid[\w]+/) ??
        href.match(/\/posts\/(\d+)/) ??
        href.match(/permalink\/(\d+)/) ??
        href.match(/story_fbid=(\d+)/);
      if (m) return m[0];
    }
    return hashText(text);
  }

  // Skip wrappers that only contain other [dir="auto"] nodes, so nested
  // messages are not emitted a second time as one concatenated blob.
  function extractMessengerText(el: HTMLElement): string {
    if (el.querySelector('[dir="auto"]')) return "";
    return (el.innerText || "").trim();
  }

  function processItem(item: HTMLElement): void {
    if (item.getAttribute(SEEN_ATTR) === "1") return;

    let text: string;
    let id: string;
    if (platform === "messenger") {
      text = extractMessengerText(item);
      // Deliberately NOT marked seen while empty. Messenger can insert the
      // element first and fill its text in a later mutation; marking it here
      // used to drop that message for good.
      if (!text) return;
      item.setAttribute(SEEN_ATTR, "1");
      id = generateMessengerId(item);
    } else {
      text = (item.innerText || "").trim();
      if (!text) return;
      item.setAttribute(SEEN_ATTR, "1");
      id = extractGroupId(item, text);
    }

    detected++;
    console.log(
      `[mautomation] detected (${id}): ${text.slice(0, 100).replace(/\n/g, " ")}`,
    );
    emit({ id, text });
  }

  // IMPORTANT: scope to the OPEN conversation pane ([role="main"]); the rest
  // of the document holds the conversation LIST, which must be ignored.
  const mains = document.querySelectorAll('[role="main"]');
  const root: HTMLElement =
    (mains[0] as HTMLElement | undefined) || document.body;

  function handleNode(node: Node): void {
    // Text filled into an element that already existed arrives as a Text
    // node, not an element — climb to the message that owns it.
    const el = node instanceof HTMLElement ? node : node.parentElement;
    if (!el || !root.contains(el)) return;
    const items: HTMLElement[] = [];
    if (el.matches(ITEM_SELECTOR)) {
      items.push(el);
    } else {
      const owner = el.closest(ITEM_SELECTOR);
      if (owner && root.contains(owner)) items.push(owner as HTMLElement);
    }
    if (node instanceof HTMLElement) {
      el.querySelectorAll(ITEM_SELECTOR).forEach((e) =>
        items.push(e as HTMLElement),
      );
    }
    for (const item of items) processItem(item);
  }

  const observer = new MutationObserver((mutations) => {
    mutationsSeen += mutations.length;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") handleNode(mutation.target);
      else mutation.addedNodes.forEach(handleNode);
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  const existing = root.querySelectorAll(ITEM_SELECTOR);
  console.log(
    `[mautomation] observer ${initial ? "attached" : "RE-attached"}. platform=${platform} ` +
      `scope=${root === document.body ? "body(no main!)" : "main"} mainCount=${mains.length} ` +
      `selector=${ITEM_SELECTOR} matchesInScope=${existing.length} ` +
      `reactToExisting=${reactToExisting && initial}`,
  );

  // Items already on screen are marked seen so only genuinely new messages
  // count. On a re-attach that is always the case: replaying history could
  // re-like a message we already liked, which toggles the like OFF.
  existing.forEach((el) => {
    const item = el as HTMLElement;
    if (reactToExisting && initial) processItem(item);
    else item.setAttribute(SEEN_ATTR, "1");
  });

  w.__mautomationObserver = observer;
  w.__mautomationStatus = () => ({
    rootConnected: root.isConnected,
    detected,
    mutations: mutationsSeen,
  });
  w.__mautomationHeartbeat = setInterval(() => {
    console.log(
      `[mautomation] heartbeat rootConnected=${root.isConnected} ` +
        `mutations=${mutationsSeen} detected=${detected} ` +
        `dirAutoInMain=${root.querySelectorAll('[dir="auto"]').length}`,
    );
  }, heartbeatMs);
}

/**
 * Watch the page for new messages and forward each to `handler`. No polling
 * of the chat and no reloads: the in-page MutationObserver pushes them.
 *
 * A Node-side watchdog checks every 20s that the observer still exists and is
 * still attached to the live conversation pane, and re-installs it if Facebook
 * reloaded the page or re-rendered the pane. Without it, either event left the
 * bot listening to nothing for the rest of the session, with no sign of it.
 *
 * Returns a function that stops the watchdog.
 */
export async function attachObserver(
  page: Page,
  handler: PostHandler,
): Promise<() => void> {
  await page.exposeBinding(
    BINDING_NAME,
    async (_source, post: DetectedPost) => {
      try {
        await handler(post);
      } catch (err) {
        logger.error({ err, postId: post.id }, "Post handler threw");
      }
    },
  );

  const install = (initial: boolean): Promise<void> =>
    page.evaluate(installObserver, {
      bindingName: BINDING_NAME,
      platform: config.facebook.platform,
      reactToExisting: config.debug.reactToExisting,
      initial,
      heartbeatMs: HEARTBEAT_MS,
    });

  await install(true);
  logger.info(
    { platform: config.facebook.platform },
    "MutationObserver attached — watching for new messages",
  );

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      logger.debug({ url: frame.url() }, "Main frame navigated");
    }
  });

  const watchdog = setInterval(() => {
    void (async () => {
      try {
        const status = await page.evaluate(
          () =>
            (window as unknown as Record<string, any>).__mautomationStatus?.() ??
            null,
        );
        if (status?.rootConnected) return;
        logger.warn(
          { status },
          status
            ? "Conversation pane was replaced — re-attaching the observer"
            : "Observer is gone (page reloaded) — re-attaching",
        );
        await install(false);
      } catch (err) {
        logger.debug(
          { err: (err as Error).message },
          "Observer watchdog check failed",
        );
      }
    })();
  }, WATCHDOG_MS);

  return () => clearInterval(watchdog);
}
