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
  type BrowsingOwner,
  type BrowsingCommand,
  type BrowsingRecord,
  type BrowsingSharing,
  type BrowsingStreamItem,
  type BrowsingTab,
  EMPTY_BROWSING_RECORD,
} from "@t3tools/contracts/signalboxBrowsing";
import * as DateTime from "effect/DateTime";

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
    case "TabShared":
      return updateTab(record, event.tabId, (tab) => ({
        ...tab,
        sharing: event.sharing,
        updatedAt: event.at,
      }));
    case "TabUnshared":
      return updateTab(record, event.tabId, ({ sharing: _sharing, ...tab }) => ({
        ...tab,
        updatedAt: event.at,
      }));
  }
}

/** Whether the tab is shared at `now` (epoch ms): shared, and its end hasn't passed. */
export function isSharedAt<T extends Pick<BrowsingTab, "sharing">>(
  tab: T,
  now: number,
): tab is T & { readonly sharing: BrowsingSharing } {
  const sharing = tab.sharing;
  return sharing !== undefined && (sharing.until === null || Date.parse(sharing.until) > now);
}

/** When the next share in the record ends on its own (epoch ms), or null when none will. */
export function nextSharingEnd(record: BrowsingRecord): number | null {
  let next: number | null = null;
  for (const tab of record.tabs) {
    const until = tab.sharing?.until;
    if (until == null) continue;
    const at = Date.parse(until);
    if (next === null || at < next) next = at;
  }
  return next;
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

/** Who owns the tabs a member opens: the person behind a device, or the agent itself. */
export function ownerOf(member: BrowsingMember): BrowsingOwner {
  return member._tag === "Device"
    ? { _tag: "Person", userId: member.userId }
    : { _tag: "Agent", agentId: member.agentId };
}

/**
 * Whether `member` drives the tab: any device of the person who owns it, or
 * the agent that owns it. An engine only loads and reports the tabs it drives.
 */
export function isOwnedBy(tab: Pick<BrowsingTab, "owner">, member: BrowsingMember | null): boolean {
  if (member === null) return false;
  return member._tag === "Device"
    ? tab.owner._tag === "Person" && tab.owner.userId === member.userId
    : tab.owner._tag === "Agent" && tab.owner.agentId === member.agentId;
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

/**
 * How long the clients offer to share a tab for, as the end of "Share …" or
 * "Keep sharing …". Null days: until the owner stops.
 */
export const BROWSING_SHARE_CHOICES = [
  { days: null, label: "until I stop" },
  { days: 1, label: "for a day" },
  { days: 3, label: "for 3 days" },
  { days: 7, label: "for a week" },
] as const;

/** When a share ends, short enough for a menu: "Mon 19 Oct, 16:40" in the reader's zone and locale. */
export function formatSharingEnd(at: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(at), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Who can see the tab and until when, in one sentence, for its owner. A
 * share whose end passed reads as private before the thread records it.
 */
export function browsingSharingNote(
  tab: Pick<BrowsingTab, "sharing">,
  now: number,
  formatEnd: (at: number) => string = formatSharingEnd,
): string {
  const sharing = tab.sharing;
  if (sharing === undefined || !isSharedAt(tab, now)) return "Private: only you can see this tab.";
  return sharing.until === null
    ? "Anyone in this thread can see it until you stop sharing."
    : `Anyone in this thread can see it until ${formatEnd(Date.parse(sharing.until))}.`;
}

/** One way to share, as a menu item: its title and the command it sends. */
export interface BrowsingShareChoice {
  readonly key: string;
  readonly title: string;
  readonly command: BrowsingCommand;
}

/**
 * The share menu for one of your own tabs, the same on every client: whether
 * it's shared now, the menu's name, who can see it and until when, the ways
 * to share, and the command that stops sharing (null while private).
 */
export function browsingShareMenu(
  tab: Pick<BrowsingTab, "id" | "sharing">,
  now: number,
): {
  readonly shared: boolean;
  readonly label: string;
  readonly note: string;
  readonly choices: ReadonlyArray<BrowsingShareChoice>;
  readonly stop: BrowsingCommand | null;
} {
  const shared = isSharedAt(tab, now);
  return {
    shared,
    label: shared ? "Shared with this thread" : "Share with this thread",
    note: browsingSharingNote(tab, now),
    choices: BROWSING_SHARE_CHOICES.map((choice) => ({
      key: String(choice.days),
      title: shared ? `Keep sharing ${choice.label}` : `Share ${choice.label}`,
      command: { _tag: "Share", tabId: tab.id, audience: "Thread", days: choice.days },
    })),
    stop: shared ? { _tag: "Unshare", tabId: tab.id } : null,
  };
}
