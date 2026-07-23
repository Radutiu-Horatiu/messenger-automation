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

/**
 * Inject a MutationObserver into the group page. Every time Facebook adds
 * a post node to the feed, we extract its text + id and forward it to the
 * Node-side handler via an exposed binding. No polling, no reloads.
 */
export async function attachObserver(
  page: Page,
  handler: PostHandler,
): Promise<void> {
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

  await page.evaluate(
    (opts: {
      bindingName: string;
      platform: Platform;
      reactToExisting: boolean;
    }) => {
      const { bindingName, platform, reactToExisting } = opts;
      const emit = (
        window as unknown as Record<string, (p: DetectedPost) => void>
      )[bindingName];

      const SEEN_ATTR = "data-mautomation-seen";
      const ID_ATTR = "data-mautomation-id";

      // Group posts render as [role="article"]. Messenger messages in the open
      // thread are plain [dir="auto"] text nodes (no role="row" — those belong
      // to the left-hand conversation list).
      const ITEM_SELECTOR =
        platform === "messenger" ? '[dir="auto"]' : '[role="article"]';

      interface DetectedPost {
        id: string;
        text: string;
      }

      function hashText(text: string): string {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
          hash = (hash * 31 + text.charCodeAt(i)) | 0;
        }
        return `text:${hash}`;
      }

      let msgCounter = 0;
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

      // Each Messenger item is a [dir="auto"] text node; its text is the
      // message content. Skip nested nodes that only wrap child [dir="auto"]
      // elements to avoid emitting concatenated duplicates.
      function extractMessengerText(el: HTMLElement): string {
        if (el.querySelector('[dir="auto"]')) return "";
        return (el.innerText || "").trim();
      }

      function processItem(item: HTMLElement): void {
        if (item.getAttribute(SEEN_ATTR) === "1") return;
        item.setAttribute(SEEN_ATTR, "1");

        let text: string;
        let id: string;
        if (platform === "messenger") {
          text = extractMessengerText(item);
          if (!text) return;
          id = generateMessengerId(item);
        } else {
          text = (item.innerText || "").trim();
          if (!text) return;
          id = extractGroupId(item, text);
        }

        console.log(
          `[mautomation] detected (${id}): ${text.slice(0, 100).replace(/\n/g, " ")}`,
        );
        emit({ id, text });
      }

      function handleNode(node: Node): void {
        if (!(node instanceof HTMLElement)) return;
        const items: HTMLElement[] = [];
        if (node.matches?.(ITEM_SELECTOR)) items.push(node);
        node
          .querySelectorAll?.(ITEM_SELECTOR)
          .forEach((el) => items.push(el as HTMLElement));
        for (const item of items) processItem(item);
      }

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach(handleNode);
        }
      });

      // IMPORTANT: scope to the OPEN conversation pane ([role="main"]).
      // The whole document also contains the left-hand conversation LIST,
      // whose entries are [role="row"] too — we must ignore those.
      const root: HTMLElement =
        (document.querySelector('[role="main"]') as HTMLElement | null) ||
        document.body;

      observer.observe(root, { childList: true, subtree: true });

      // Diagnostics: candidate counts scoped to the conversation pane.
      const existing = root.querySelectorAll(ITEM_SELECTOR);
      console.log(
        `[mautomation] observer attached. platform=${platform} ` +
          `scope=${root === document.body ? "body(no main!)" : "main"} ` +
          `selector=${ITEM_SELECTOR} matchesInScope=${existing.length} ` +
          `rowsInMain=${root.querySelectorAll('[role="row"]').length} ` +
          `gridcellsInMain=${root.querySelectorAll('[role="gridcell"]').length} ` +
          `dirAutoInMain=${root.querySelectorAll('[dir="auto"]').length} ` +
          `reactToExisting=${reactToExisting}`,
      );

      // Items already on screen: either react (testing) or mark as seen so we
      // only act on genuinely new messages that arrive after startup.
      existing.forEach((el) => {
        const item = el as HTMLElement;
        if (reactToExisting) {
          processItem(item);
        } else {
          item.setAttribute(SEEN_ATTR, "1");
        }
      });

      (window as unknown as Record<string, unknown>).__mautomationObserver =
        observer;
    },
    {
      bindingName: BINDING_NAME,
      platform: config.facebook.platform,
      reactToExisting: config.debug.reactToExisting,
    },
  );

  logger.info(
    { platform: config.facebook.platform },
    "MutationObserver attached — watching for new messages",
  );
}
