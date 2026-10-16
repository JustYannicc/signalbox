import type {
  BrowsingMember,
  BrowsingPosition,
  BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";

import { isOwnChange } from "./browsingRecord.ts";

/**
 * Where a page was read to, read and restored inside the page by every
 * engine the same way (desktop `<webview>`, the mobile WebView). The anchor is
 * the start of the passage at the top of the viewport, kept as a text
 * directive the way Chrome's Send Tab to Self carries it, so it survives a
 * different screen size; the scroll ratio is the fallback when that text is
 * gone. A playing video's time comes along.
 *
 * The scripts are plain source, injected as is: they can't import anything.
 */

/** How many words of the passage make the anchor: enough to be unique, short enough to survive edits. */
const ANCHOR_WORDS = 8;
/** Shorter passages (menus, labels) repeat too often to anchor on. */
const MIN_ANCHOR_LENGTH = 20;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text directive for a passage: its first words, with the directive's own `-` and `,` escaped. */
export function textFragmentFor(text: string): string | undefined {
  const passage = normalize(text);
  if (passage.length < MIN_ANCHOR_LENGTH) return undefined;
  const words = passage.split(" ").slice(0, ANCHOR_WORDS).join(" ");
  return encodeURIComponent(words).replace(/-/g, "%2D").replace(/,/g, "%2C");
}

/** The passage a text directive starts at, ignoring any prefix, end and suffix. */
export function textFromFragment(fragment: string): string {
  const parts = fragment.split(",");
  const start =
    parts.find((part) => !part.endsWith("-") && !part.startsWith("-")) ?? parts[0] ?? "";
  try {
    return normalize(decodeURIComponent(start));
  } catch {
    return normalize(start);
  }
}

/** What a page reported, if it's a position; pages are untrusted, so anything else is dropped. */
export function parseCapturedPosition(raw: unknown): BrowsingPosition | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { scrollRatio, textFragment, mediaSeconds } = value as Record<string, unknown>;
  if (typeof scrollRatio !== "number" || !(scrollRatio >= 0 && scrollRatio <= 1)) return null;
  return {
    scrollRatio: Math.round(scrollRatio * 1000) / 1000,
    ...(typeof textFragment === "string" && textFragment.length > 0 && textFragment.length <= 1_024
      ? { textFragment }
      : {}),
    ...(typeof mediaSeconds === "number" && mediaSeconds >= 0
      ? { mediaSeconds: Math.round(mediaSeconds) }
      : {}),
  };
}

/** How far a playing video moves before its time is worth syncing again. */
const MEDIA_SECONDS_STEP = 30;

/** Whether two positions are close enough that reporting the second changes nothing worth syncing. */
export function samePagePosition(a: BrowsingPosition | undefined, b: BrowsingPosition): boolean {
  if (a === undefined) return false;
  const sameMedia =
    a.mediaSeconds === undefined || b.mediaSeconds === undefined
      ? a.mediaSeconds === b.mediaSeconds
      : Math.abs(a.mediaSeconds - b.mediaSeconds) < MEDIA_SECONDS_STEP;
  return (
    sameMedia && a.textFragment === b.textFragment && Math.abs(a.scrollRatio - b.scrollRatio) < 0.01
  );
}

/** The top of a page with nothing playing: nowhere worth restoring or reporting. */
const isPageTop = (position: BrowsingPosition) =>
  position.scrollRatio === 0 &&
  position.textFragment === undefined &&
  position.mediaSeconds === undefined;

/** The tab's position to restore when this engine loads it: someone else's, below the top. */
export function restorablePosition(
  tab: Pick<BrowsingTab, "position" | "positionBy">,
  you: BrowsingMember | null,
): BrowsingPosition | null {
  const { position } = tab;
  if (position === undefined || you === null || isOwnChange(tab.positionBy, you)) return null;
  return isPageTop(position) ? null : position;
}

/** Whether what this engine read to is worth a `Position` for the tab. */
export function positionMoved(
  tab: Pick<BrowsingTab, "position">,
  captured: BrowsingPosition,
): boolean {
  return tab.position === undefined
    ? !isPageTop(captured)
    : !samePagePosition(tab.position, captured);
}

/** How far up from a hit-tested element capture and restore look for the passage's block. */
const MAX_CLIMB = 4;

/**
 * Evaluates to the page's position as JSON. Finds the passage under the top
 * of the viewport with a few hit tests and `textContent` (no layout) rather
 * than walking the document, so it stays cheap on long pages.
 */
export const capturePagePositionScript = `(() => {
  const root = document.scrollingElement || document.documentElement;
  const max = root.scrollHeight - window.innerHeight;
  const y = window.scrollY || root.scrollTop || 0;
  const ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
  let textFragment;
  if (y > 0) {
    for (let probe = 8; probe < Math.min(160, window.innerHeight); probe += 24) {
      let element = document.elementFromPoint(Math.round(window.innerWidth / 3), probe);
      for (let climb = 0; element && element !== document.body && climb < ${MAX_CLIMB}; climb++) {
        const text = (element.textContent || "").slice(0, 2000).replace(/\\s+/g, " ").trim();
        if (text.length >= ${MIN_ANCHOR_LENGTH}) {
          const words = text.split(" ").slice(0, ${ANCHOR_WORDS}).join(" ");
          textFragment = encodeURIComponent(words).replace(/-/g, "%2D").replace(/,/g, "%2C");
          break;
        }
        element = element.parentElement;
      }
      if (textFragment) break;
    }
  }
  const video = document.querySelector("video");
  const mediaSeconds = video && video.currentTime > 0 ? Math.round(video.currentTime) : undefined;
  return JSON.stringify({ scrollRatio: ratio, textFragment, mediaSeconds });
})()`;

/**
 * Evaluates to whether the page moved to `position`: to the passage when it
 * finds it, else to the scroll ratio. Pages that render late (Docs, most
 * apps) aren't there yet at load, so it tries again a few times.
 */
export function restorePagePositionScript(position: BrowsingPosition): string {
  const passage =
    position.textFragment === undefined ? null : textFromFragment(position.textFragment);
  return `(() => {
  const passage = ${JSON.stringify(passage)};
  const ratio = ${JSON.stringify(position.scrollRatio)};
  const mediaSeconds = ${JSON.stringify(position.mediaSeconds ?? null)};
  const normalize = (text) => (text || "").replace(/\\s+/g, " ").trim();
  // Text nodes holding the passage's first word, then a short climb to the block it starts:
  // linear in the page's text, not in its depth.
  const firstWord = passage ? passage.split(" ")[0] : "";
  const findPassage = () => {
    if (!passage) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.data.includes(firstWord)) continue;
      let element = node.parentElement;
      for (let climb = 0; element && element !== document.body && climb < ${MAX_CLIMB}; climb++) {
        const text = normalize((element.textContent || "").slice(0, passage.length * 4 + 200));
        // Only a passage on screen counts: collapsed sections (mobile Wikipedia) hide theirs.
        if (text.includes(passage) && element.getClientRects().length > 0) return element;
        element = element.parentElement;
      }
    }
    return null;
  };
  const apply = () => {
    if (mediaSeconds !== null) {
      const video = document.querySelector("video");
      if (video) video.currentTime = mediaSeconds;
    }
    const target = findPassage();
    if (target) {
      target.scrollIntoView({ block: "start" });
      if (window.scrollY > 0 || ratio === 0) return true;
    }
    const root = document.scrollingElement || document.documentElement;
    const max = root.scrollHeight - window.innerHeight;
    if (max <= 0) return false;
    window.scrollTo(0, Math.round(ratio * max));
    return ratio === 0 || window.scrollY > 0;
  };
  if (apply()) return true;
  // Retries stop the moment the reader takes over, so a late page never yanks them back.
  let done = false;
  const stop = () => { done = true; };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach((type) =>
    window.addEventListener(type, stop, { once: true, passive: true, capture: true }),
  );
  [400, 1200, 3000].forEach((delay) =>
    setTimeout(() => { if (!done && apply()) done = true; }, delay),
  );
  return false;
})()`;
}
