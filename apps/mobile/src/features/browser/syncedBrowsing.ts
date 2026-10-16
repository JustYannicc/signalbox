/**
 * The decisions behind the synced browser panel (#585): what the phone's own
 * WebView reports to the thread's browsing record, and what it takes from it.
 * The record is shared; back/forward and the WebView's history stay on the device.
 */
import {
  activeBrowsingTab,
  browsingTabHost,
  browsingTabLabel,
  isOwnedBy,
  reportableUrl,
  samePageUrl,
} from "@t3tools/client-runtime/browsing";
import {
  capturePagePositionScript,
  parseCapturedPosition,
  positionMoved,
  restorablePosition,
  samePagePosition,
} from "@t3tools/client-runtime/browsing/page-position";
import {
  BROWSING_TITLE_MAX_LENGTH,
  type BrowsingCommand,
  type BrowsingMember,
  type BrowsingPosition,
  type BrowsingRecord,
  type BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";

const PAGE_MESSAGE_TYPE = "signalbox-browsing";

export interface ReportedPage {
  readonly url: string;
  readonly title: string;
}

/**
 * The `Navigate` to send after the WebView finished loading `url`, or null
 * when the record already says so. While this device's own report is on the
 * way (`lastReported`), that report is what the record is about to say.
 * An empty title never overwrites a known one for the same page.
 */
export function navigateCommand(
  tab: BrowsingTab,
  you: BrowsingMember | null,
  page: { readonly url: string | null | undefined; readonly title: string | null | undefined },
  lastReported: ReportedPage | null,
): BrowsingCommand | null {
  const url = reportableUrl(page.url);
  if (url === null || !isOwnedBy(tab, you)) return null;
  const title = (page.title ?? "").trim().slice(0, BROWSING_TITLE_MAX_LENGTH);
  const known = (candidate: ReportedPage | null) =>
    candidate !== null &&
    samePageUrl(candidate.url, url) &&
    (title.length === 0 || candidate.title === title);
  const expected = lastReported ?? (tab.url === null ? null : { url: tab.url, title: tab.title });
  if (known(expected)) return null;
  return { _tag: "Navigate", tabId: tab.id, url, title };
}

/**
 * The `Position` to send for where the reader is on `pageUrl`, or null when
 * it's a no-op or the record doesn't hold that page yet (its report is first in line).
 */
export function positionCommand(
  tab: BrowsingTab,
  you: BrowsingMember | null,
  captured: BrowsingPosition,
  pageUrl: string | null,
  lastReported: ReportedPage | null,
): BrowsingCommand | null {
  const onPage = samePageUrl(pageUrl, tab.url) || samePageUrl(pageUrl, lastReported?.url);
  if (!onPage || !isOwnedBy(tab, you) || !positionMoved(tab, captured)) return null;
  return { _tag: "Position", tabId: tab.id, position: captured };
}

/**
 * Where to move the page once it loaded: the tab's position when someone
 * else (another device, an agent) left it there and it isn't already applied.
 */
export function positionToRestore(
  tab: BrowsingTab,
  you: BrowsingMember | null,
  restored: BrowsingPosition | null,
): BrowsingPosition | null {
  const position = isOwnedBy(tab, you) ? restorablePosition(tab, you) : null;
  if (position === null) return null;
  return restored !== null && samePagePosition(restored, position) ? null : position;
}

/**
 * The address to load because the record's tab moved to a page this device
 * isn't showing and didn't report itself (`reported`: its reports still on
 * the way). Only a change counts, so a device that navigated locally isn't
 * dragged back to the record's older page.
 */
export function urlToFollow(input: {
  readonly tab: BrowsingTab;
  readonly you: BrowsingMember | null;
  readonly previousRecordUrl: string | null;
  readonly reported: ReadonlyArray<ReportedPage>;
  readonly viewUrl: string | null;
}): string | null {
  const recordUrl = input.tab.url;
  if (recordUrl === null || recordUrl === input.previousRecordUrl) return null;
  if (!isOwnedBy(input.tab, input.you)) return null;
  if (samePageUrl(recordUrl, input.viewUrl)) return null;
  if (input.reported.some((page) => samePageUrl(page.url, recordUrl))) return null;
  return reportableUrl(recordUrl);
}

/** A report this device sent and hasn't seen in the record yet. */
export interface PendingReport extends ReportedPage {
  readonly at: number;
}

/** Long enough for any report to come back; a lost one stops masking the page after this. */
const REPORT_TTL_MS = 30_000;

/**
 * The reports still on the way once the record's tab is at `recordUrl`.
 * A tab's commands apply in order, so reaching one of them settles it and
 * every report before it.
 */
export function settleReports(
  pending: ReadonlyArray<PendingReport>,
  recordUrl: string | null,
  now: number,
): ReadonlyArray<PendingReport> {
  const fresh = pending.filter((report) => now - report.at < REPORT_TTL_MS);
  const reached = fresh.findLastIndex((report) => samePageUrl(report.url, recordUrl));
  return reached === -1 ? fresh : fresh.slice(reached + 1);
}

/**
 * Which engine runs a tab. Only the owner drives a tab, so only your own
 * tabs load in this device's WebView; an agent's run in its browser in the
 * cloud, and another person's in theirs.
 */
export function browsingTabEngine(
  tab: BrowsingTab,
  you: BrowsingMember | null,
): "here" | "agent" | "person" {
  if (isOwnedBy(tab, you)) return "here";
  return tab.owner._tag === "Agent" ? "agent" : "person";
}

/** The tab switcher's second line: whose tab it is when it isn't yours, then its host. */
export function browsingTabSubtitle(
  tab: BrowsingTab,
  you: BrowsingMember | null,
): string | undefined {
  const engine = browsingTabEngine(tab, you);
  const owner = engine === "agent" ? "Agent" : engine === "person" ? "Someone else" : null;
  const host = browsingTabHost(tab.url);
  const shownHost = host !== null && host !== browsingTabLabel(tab) ? host : null;
  const parts = [owner, shownHost].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A tab this device picked, until the record says which tab is active. */
export interface PendingActivation {
  readonly tabId: string;
  /** The record's active tab when the pick was made. */
  readonly sinceActiveTabId: string | null;
}

/**
 * The tab the panel shows: the record's active tab, except right after a pick
 * on this device and before the record moved, so a pick never flickers back.
 * Any later change to the record's active tab wins, whoever made it.
 */
export function shownBrowsingTab(
  record: BrowsingRecord,
  pending: PendingActivation | null,
): BrowsingTab | null {
  if (pending !== null && record.activeTabId === pending.sinceActiveTabId) {
    const picked = record.tabs.find((tab) => tab.id === pending.tabId);
    if (picked !== undefined) return picked;
  }
  return activeBrowsingTab(record);
}

export type PageMessage =
  | { readonly kind: "page"; readonly title: string }
  | { readonly kind: "position"; readonly position: BrowsingPosition };

/**
 * A message the panel's script posted from the page. The page can call the
 * same bridge, so everything is checked: the shape, and that it's for `tabId`.
 */
export function parsePageMessage(data: unknown, tabId: string): PageMessage | null {
  if (typeof data !== "string" || data.length > 8_192) return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const fields = message as Record<string, unknown>;
  if (fields.type !== PAGE_MESSAGE_TYPE || fields.tabId !== tabId) return null;
  if (fields.kind === "page") {
    return typeof fields.title === "string"
      ? { kind: "page", title: fields.title.slice(0, BROWSING_TITLE_MAX_LENGTH) }
      : null;
  }
  if (fields.kind === "position") {
    const position = parseCapturedPosition(fields.position);
    return position === null ? null : { kind: "position", position };
  }
  return null;
}

/** How long the page waits after a scroll settles before it reports where the reader is. */
const SCROLL_SETTLE_MS = 300;

/**
 * Installed in every page the panel loads (main frame only). Reports the
 * title when it changes, and the reader's position once they scroll by hand:
 * programmatic scrolls (restoring, anchors) aren't the reader moving.
 */
export function browsingPageScript(tabId: string): string {
  return `(function () {
  if (window.__signalboxBrowsing) return;
  window.__signalboxBrowsing = true;
  var bridge = window.ReactNativeWebView;
  if (!bridge) return;
  var post = function (message) {
    message.type = ${JSON.stringify(PAGE_MESSAGE_TYPE)};
    message.tabId = ${JSON.stringify(tabId)};
    bridge.postMessage(JSON.stringify(message));
  };
  var reading = false;
  var timer = null;
  var position = function () {
    try { post({ kind: "position", position: ${capturePagePositionScript} }); } catch (error) {}
  };
  ["touchstart", "wheel", "keydown"].forEach(function (type) {
    window.addEventListener(type, function () { reading = true; }, { passive: true, capture: true });
  });
  window.addEventListener("scroll", function () {
    if (!reading) return;
    clearTimeout(timer);
    timer = setTimeout(position, ${SCROLL_SETTLE_MS});
  }, { passive: true });
  var title = null;
  var page = function () {
    if (document.title === title) return;
    title = document.title;
    post({ kind: "page", title: title || "" });
  };
  window.addEventListener("popstate", page);
  window.addEventListener("hashchange", page);
  if (window.MutationObserver && document.head) {
    new MutationObserver(page).observe(document.head, { subtree: true, childList: true, characterData: true });
  }
  page();
})();
true;`;
}
