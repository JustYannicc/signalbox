import { reportableUrl, samePageUrl } from "@t3tools/client-runtime/browsing";
import {
  capturePagePositionScript,
  positionMoved,
  restorablePosition,
} from "@t3tools/client-runtime/browsing/page-position";
import type {
  BrowsingCommand,
  BrowsingMember,
  BrowsingPosition,
  BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";

/**
 * What one device's engine does with a record tab (#585): follow where someone
 * else took it, restore where they read to, and report where this device
 * reads. Pure; `BrowsingTabEngine.tsx` runs it against a desktop `<webview>`.
 */

/** A page this engine showed this recently is treated as an echo of its own report. */
export const OWN_VISIT_WINDOW_MS = 10_000;

/** What an engine remembers about its own navigation, to tell echoes from other people's moves. */
export interface EngineNavigation {
  /** The URL the engine shows now; null before its first load reported. */
  readonly localUrl: string | null;
  /** Pages it showed lately, with when. */
  readonly visits: ReadonlyArray<{ readonly url: string; readonly at: number }>;
  /** Where URLs it was sent to actually landed, so a redirect can't start a tug of war. */
  readonly landings: ReadonlyArray<{ readonly sentTo: string; readonly landed: string }>;
  /** A URL it was sent to and hasn't landed from yet, and the page it was on then. */
  readonly sentTo: string | null;
  readonly sentFrom: string | null;
}

export function initialEngineNavigation(url: string | null): EngineNavigation {
  return { localUrl: url, visits: [], landings: [], sentTo: url, sentFrom: null };
}

const MAX_VISITS = 20;
const MAX_LANDINGS = 20;

/** The engine finished loading `url`. */
export function engineVisited(
  navigation: EngineNavigation,
  url: string,
  now: number,
): EngineNavigation {
  const { sentTo, sentFrom } = navigation;
  // A late report of the page it was sent away from isn't where it landed.
  if (sentTo !== null && !samePageUrl(url, sentTo) && samePageUrl(url, sentFrom)) {
    return navigation;
  }
  const landings =
    sentTo === null || samePageUrl(sentTo, url)
      ? navigation.landings
      : [
          { sentTo, landed: url },
          ...navigation.landings.filter((landing) => !samePageUrl(landing.sentTo, sentTo)),
        ].slice(0, MAX_LANDINGS);
  return {
    localUrl: url,
    visits: [
      { url, at: now },
      ...navigation.visits.filter(
        (visit) => !samePageUrl(visit.url, url) && now - visit.at < OWN_VISIT_WINDOW_MS,
      ),
    ].slice(0, MAX_VISITS),
    landings,
    sentTo: null,
    sentFrom: null,
  };
}

export const engineSentTo = (navigation: EngineNavigation, url: string): EngineNavigation => ({
  ...navigation,
  sentTo: url,
  sentFrom: navigation.localUrl,
});

/**
 * Where to take the engine because the record's URL for the tab moved, or
 * null. Only a change of the record's URL counts, so a page that fails to
 * load isn't retried on every unrelated update.
 */
export function navigationToFollow(input: {
  readonly recordUrl: string | null;
  readonly previousRecordUrl: string | null;
  readonly navigation: EngineNavigation;
  readonly now: number;
}): string | null {
  const { previousRecordUrl, navigation, now } = input;
  const recordUrl = reportableUrl(input.recordUrl);
  if (recordUrl === null || samePageUrl(recordUrl, previousRecordUrl)) return null;
  const landed =
    navigation.landings.find((landing) => samePageUrl(landing.sentTo, recordUrl))?.landed ?? null;
  if (
    samePageUrl(recordUrl, navigation.localUrl) ||
    samePageUrl(recordUrl, navigation.sentTo) ||
    samePageUrl(landed, navigation.localUrl)
  ) {
    return null;
  }
  const ownVisit = navigation.visits.some(
    (visit) => samePageUrl(visit.url, recordUrl) && now - visit.at < OWN_VISIT_WINDOW_MS,
  );
  return ownVisit ? null : recordUrl;
}

/** The position to put the page at, when someone else read this page to somewhere. */
export function positionToRestore(
  tab: BrowsingTab | undefined,
  you: BrowsingMember | null,
  localUrl: string | null,
): BrowsingPosition | null {
  if (tab === undefined || !samePageUrl(tab.url, localUrl)) return null;
  return restorablePosition(tab, you);
}

/** The `Position` command for what this engine read to, unless it changes nothing worth syncing. */
export function positionToReport(
  tab: BrowsingTab | undefined,
  localUrl: string | null,
  captured: BrowsingPosition | null,
): BrowsingCommand | null {
  if (tab === undefined || captured === null || !samePageUrl(tab.url, localUrl)) return null;
  return positionMoved(tab, captured)
    ? { _tag: "Position", tabId: tab.id, position: captured }
    : null;
}

/** Keys that scroll the page when nothing editable has focus. */
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
/** A scroll this long after the reader's hand moved still counts as theirs (momentum, smooth scrolling). */
const READER_SCROLL_WINDOW_MS = 1_000;

/**
 * Installed once per page load. Marks the page read-on only when a scroll
 * follows the reader's own wheel, touch, scroll key or scrollbar drag, so
 * feeds that scroll themselves, anchor jumps and restores report nothing.
 */
export const readerScrollTrackerScript = `(() => {
  if (window.__signalboxBrowsing) return true;
  const state = { dirty: false };
  window.__signalboxBrowsing = state;
  let handUntil = 0;
  const hand = () => { handUntil = Date.now() + ${READER_SCROLL_WINDOW_MS}; };
  const options = { passive: true, capture: true };
  window.addEventListener("wheel", hand, options);
  window.addEventListener("touchmove", hand, options);
  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (!editing && ${JSON.stringify(SCROLL_KEYS)}.includes(event.key)) hand();
  }, options);
  window.addEventListener("pointerdown", (event) => {
    const root = document.documentElement;
    if (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight) hand();
  }, options);
  window.addEventListener("scroll", () => {
    if (Date.now() <= handUntil) state.dirty = true;
  }, options);
  return true;
})()`;

/**
 * The poll: evaluates to the captured position JSON when the reader scrolled
 * since the last one, else null. Clean pages cost a property read.
 */
export const captureIfReadScript = `(() => {
  const state = window.__signalboxBrowsing;
  if (!state) { ${readerScrollTrackerScript}; return null; }
  if (!state.dirty) return null;
  state.dirty = false;
  return ${capturePagePositionScript};
})()`;
