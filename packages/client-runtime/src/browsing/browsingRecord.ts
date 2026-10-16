import {
  PREVIEW_URL_MAX_LENGTH,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  BROWSING_MAX_HISTORY,
  type BrowsingEvent,
  type BrowsingHistoryEntry,
  type BrowsingMember,
  type BrowsingRecord,
  type BrowsingStreamItem,
  type BrowsingTab,
  EMPTY_BROWSING_RECORD,
} from "@t3tools/contracts/signalboxBrowsing";

/**
 * A thread's browsing record folded from its stream (`signalboxBrowsing.ts`).
 * Signalbox Cloud folds its log with the same function, so the thread and
 * every device agree on what each event means.
 */

const byOrderKey = (a: BrowsingTab, b: BrowsingTab) =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1;

const withHistory = (
  history: ReadonlyArray<BrowsingHistoryEntry>,
  entry: BrowsingHistoryEntry,
): ReadonlyArray<BrowsingHistoryEntry> => {
  // A title arriving after its page loaded names the same visit.
  if (history[0]?.url === entry.url)
    return [{ ...history[0], title: entry.title }, ...history.slice(1)];
  return [entry, ...history].slice(0, BROWSING_MAX_HISTORY);
};

const updateTab = (
  record: BrowsingRecord,
  tabId: string,
  update: (tab: BrowsingTab) => BrowsingTab,
): BrowsingRecord => {
  const index = record.tabs.findIndex((tab) => tab.id === tabId);
  const current = record.tabs[index];
  if (current === undefined) return record;
  const tabs = record.tabs.slice();
  tabs[index] = update(current);
  return { ...record, tabs };
};

export function applyBrowsingEvent(record: BrowsingRecord, event: BrowsingEvent): BrowsingRecord {
  switch (event._tag) {
    case "TabOpened": {
      if (record.tabs.some((tab) => tab.id === event.tab.id)) return record;
      const tabs = [...record.tabs, event.tab].sort(byOrderKey);
      return {
        ...record,
        tabs,
        history:
          event.tab.url === null
            ? record.history
            : withHistory(record.history, {
                url: event.tab.url,
                title: event.tab.title,
                at: event.at,
              }),
      };
    }
    case "TabNavigated": {
      const next = updateTab(record, event.tabId, (tab) => {
        // A new page starts at its top; the old position belonged to the old page.
        const { position: _position, positionBy: _positionBy, ...page } = tab;
        return {
          ...(tab.url === event.url ? tab : page),
          url: event.url,
          title: event.title,
          updatedAt: event.at,
        };
      });
      if (next === record) return record;
      return {
        ...next,
        history: withHistory(next.history, { url: event.url, title: event.title, at: event.at }),
      };
    }
    case "TabMoved": {
      const next = updateTab(record, event.tabId, (tab) => ({
        ...tab,
        orderKey: event.orderKey,
        updatedAt: event.at,
      }));
      return next === record ? record : { ...next, tabs: next.tabs.slice().sort(byOrderKey) };
    }
    case "TabActivated":
      if (event.tabId !== null && !record.tabs.some((tab) => tab.id === event.tabId)) return record;
      return record.activeTabId === event.tabId ? record : { ...record, activeTabId: event.tabId };
    case "TabClosed": {
      if (!record.tabs.some((tab) => tab.id === event.tabId)) return record;
      return {
        ...record,
        tabs: record.tabs.filter((tab) => tab.id !== event.tabId),
        activeTabId: record.activeTabId === event.tabId ? null : record.activeTabId,
      };
    }
    case "TabPositioned":
      return updateTab(record, event.tabId, (tab) => ({
        ...tab,
        position: event.position,
        positionBy: event.by,
        updatedAt: event.at,
      }));
  }
}

/**
 * What a device holds of one thread's record: `you` is this connection as
 * the record names it, null until the first snapshot arrived.
 */
export interface BrowsingState {
  readonly you: BrowsingMember | null;
  readonly sequence: number;
  readonly record: BrowsingRecord;
}

export const INITIAL_BROWSING_STATE: BrowsingState = {
  you: null,
  sequence: 0,
  record: EMPTY_BROWSING_RECORD,
};

/** Folds one stream item. A resubscribe starts with a fresh snapshot, so replays are skipped. */
export function foldBrowsingItem(state: BrowsingState, item: BrowsingStreamItem): BrowsingState {
  if (item._tag === "Snapshot") {
    return { you: item.you, sequence: item.sequence, record: item.record };
  }
  if (item.event.sequence <= state.sequence) return state;
  return {
    you: state.you,
    sequence: item.event.sequence,
    record: applyBrowsingEvent(state.record, item.event),
  };
}

/** The tab a device shows: the active one, else the first. */
export function activeBrowsingTab(record: BrowsingRecord): BrowsingTab | null {
  return record.tabs.find((tab) => tab.id === record.activeTabId) ?? record.tabs[0] ?? null;
}

/** Whether this device made the change, so it doesn't reapply it to its own engine. */
export function isOwnChange(by: BrowsingMember | undefined, you: BrowsingMember | null): boolean {
  return (
    by?._tag === "Device" &&
    you?._tag === "Device" &&
    by.deviceId === you.deviceId &&
    by.userId === you.userId
  );
}

/** A tab's host, for labels and favicons; null for an address that isn't a URL. */
export function browsingTabHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** A tab's label: its title, else its host, else its address. */
export function browsingTabLabel(tab: Pick<BrowsingTab, "title" | "url">): string {
  const title = tab.title.trim();
  if (title.length > 0) return title;
  if (tab.url === null) return "New tab";
  return browsingTabHost(tab.url) ?? tab.url;
}

/** The address an engine reports to the record: web pages only, within the contract's bound. */
export function reportableUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > PREVIEW_URL_MAX_LENGTH) {
    return null;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Two addresses for the same page. Engines normalize (`example.com` →
 * `example.com/`) and append text directives, neither of which is a navigation.
 */
export function samePageUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const normalize = (url: string) => {
    const withoutDirective = url.replace(/:~:.*$/, "").replace(/#$/, "");
    try {
      return new URL(withoutDirective).href.replace(/#$/, "");
    } catch {
      return withoutDirective;
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * The record serves the browser panel's sessions under one stable epoch: it
 * outlives every server process, so its revisions never reset.
 */
export const BROWSING_PREVIEW_EPOCH = "thread-browsing";

/** A record tab as the browser panel's session. Each device layers its own viewport, zoom and history on top. */
export function browsingTabSnapshot(threadId: ThreadId, tab: BrowsingTab): PreviewSessionSnapshot {
  return {
    threadId,
    tabId: tab.id,
    navStatus:
      tab.url === null ? { _tag: "Idle" } : { _tag: "Success", url: tab.url, title: tab.title },
    canGoBack: false,
    canGoForward: false,
    runtime: "desktop",
    updatedAt: tab.updatedAt,
  };
}
