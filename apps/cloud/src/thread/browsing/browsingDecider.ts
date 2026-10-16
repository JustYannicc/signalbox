import {
  BROWSING_MAX_TABS,
  type BrowsingCommand,
  type BrowsingEvent,
  type BrowsingMember,
  type BrowsingPosition,
  type BrowsingRecord,
  type BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";
import { isOwnedBy, isSharedAt, ownerOf } from "@t3tools/client-runtime/browsing";
import * as DateTime from "effect/DateTime";
import { generateKeyBetween } from "fractional-indexing";

/**
 * What a browsing command does to a thread's record, without I/O. Commands
 * about a tab that is gone change nothing: a device reporting a page it
 * closed a moment ago, or a retry, is normal and not worth an error.
 */

export interface BrowsingDecisionContext {
  readonly by: BrowsingMember;
  readonly at: string;
  /** The record's sequence now; the first event gets the next one. */
  readonly sequence: number;
}

export type BrowsingDecision =
  | { readonly _tag: "Events"; readonly events: ReadonlyArray<BrowsingEvent> }
  | { readonly _tag: "Rejected"; readonly reason: string };

const NOTHING: BrowsingDecision = { _tag: "Events", events: [] };
const NOT_OWNER = "Only the tab's owner can change it.";
/** Which commands only a tab's owner may send; a new command has to choose. */
const OWNER_ONLY: Record<BrowsingCommand["_tag"], boolean> = {
  Open: false,
  Navigate: true,
  Move: false,
  Activate: false,
  Close: true,
  CloseAll: false,
  Position: true,
  Share: true,
  Unshare: true,
};

/** An event before the thread numbers it. */
type EventDraft = BrowsingEvent extends infer E
  ? E extends BrowsingEvent
    ? Omit<E, "sequence">
    : never
  : never;

const samePosition = (a: BrowsingPosition | undefined, b: BrowsingPosition) =>
  a !== undefined &&
  a.scrollRatio === b.scrollRatio &&
  a.textFragment === b.textFragment &&
  a.mediaSeconds === b.mediaSeconds;

/** The key between two neighbours, either of which can be the end. */
const keyBetween = (before: BrowsingTab | undefined, after: BrowsingTab | undefined) =>
  generateKeyBetween(before?.orderKey ?? null, after?.orderKey ?? null);

const drafts = (
  record: BrowsingRecord,
  command: BrowsingCommand,
  { by, at }: BrowsingDecisionContext,
): ReadonlyArray<EventDraft> | string => {
  if (command._tag === "CloseAll") {
    // Everyone's own tabs only. Closing the active tab clears it, so nothing needs activating after.
    return record.tabs
      .filter((tab) => isOwnedBy(tab, by))
      .map((tab): EventDraft => ({ _tag: "TabClosed", by, at, tabId: tab.id }));
  }
  const index = record.tabs.findIndex((tab) => tab.id === command.tabId);
  const tab = record.tabs[index];
  // Only the owner drives a tab or shares it (#343, #597); switching to it and reordering are the thread's.
  if (tab !== undefined && OWNER_ONLY[command._tag] && !isOwnedBy(tab, by)) {
    return NOT_OWNER;
  }
  switch (command._tag) {
    case "Open": {
      if (tab !== undefined) return [];
      if (record.tabs.length >= BROWSING_MAX_TABS) {
        return `A thread keeps up to ${BROWSING_MAX_TABS} tabs. Close one first.`;
      }
      const afterIndex =
        command.afterTabId === undefined
          ? -1
          : record.tabs.findIndex((other) => other.id === command.afterTabId);
      const orderKey =
        afterIndex === -1
          ? keyBetween(record.tabs.at(-1), undefined)
          : keyBetween(record.tabs[afterIndex], record.tabs[afterIndex + 1]);
      const opened: EventDraft = {
        _tag: "TabOpened",
        by,
        at,
        tab: {
          id: command.tabId,
          url: command.url ?? null,
          title: command.title ?? "",
          orderKey,
          owner: ownerOf(by),
          updatedAt: at,
        },
      };
      return command.activate
        ? [opened, { _tag: "TabActivated", by, at, tabId: command.tabId }]
        : [opened];
    }
    case "Navigate":
      if (tab === undefined || (tab.url === command.url && tab.title === command.title)) return [];
      return [
        { _tag: "TabNavigated", by, at, tabId: tab.id, url: command.url, title: command.title },
      ];
    case "Move": {
      if (tab === undefined || command.beforeTabId === tab.id) return [];
      const others = record.tabs.filter((other) => other.id !== tab.id);
      const nextIndex =
        command.beforeTabId === null
          ? others.length
          : others.findIndex((other) => other.id === command.beforeTabId);
      if (nextIndex === -1) return [];
      const before = others[nextIndex - 1];
      const after = others[nextIndex];
      // Already there: the tab's own neighbours are the ones asked for.
      if (record.tabs[index - 1]?.id === before?.id && record.tabs[index + 1]?.id === after?.id) {
        return [];
      }
      return [{ _tag: "TabMoved", by, at, tabId: tab.id, orderKey: keyBetween(before, after) }];
    }
    case "Activate":
      if (tab === undefined || record.activeTabId === tab.id) return [];
      return [{ _tag: "TabActivated", by, at, tabId: tab.id }];
    case "Close": {
      if (tab === undefined) return [];
      const closed: EventDraft = { _tag: "TabClosed", by, at, tabId: tab.id };
      if (record.activeTabId !== tab.id) return [closed];
      // Chrome activates the tab to the right, else the one to the left.
      const next = record.tabs[index + 1] ?? record.tabs[index - 1];
      return [closed, { _tag: "TabActivated", by, at, tabId: next?.id ?? null }];
    }
    case "Position":
      if (tab === undefined || samePosition(tab.position, command.position)) return [];
      return [{ _tag: "TabPositioned", by, at, tabId: tab.id, position: command.position }];
    case "Share": {
      if (tab === undefined) return [];
      const until =
        command.days === null
          ? null
          : DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { days: command.days }));
      const current = tab.sharing;
      if (current?.audience === command.audience && current.until === until) return [];
      // A share whose end passed (not recorded yet) is over: sharing again starts anew.
      const still = isSharedAt(tab, DateTime.toEpochMillis(DateTime.makeUnsafe(at)));
      const since = still && current?.audience === command.audience ? current.since : at;
      return [
        {
          _tag: "TabShared",
          by,
          at,
          tabId: tab.id,
          sharing: { audience: command.audience, until, since, by },
        },
      ];
    }
    case "Unshare":
      if (tab?.sharing === undefined) return [];
      return [{ _tag: "TabUnshared", by, at, tabId: tab.id, reason: "Stopped" }];
  }
};

const numbered = (
  drafts: ReadonlyArray<EventDraft>,
  sequence: number,
): ReadonlyArray<BrowsingEvent> =>
  drafts.map((draft, offset): BrowsingEvent => ({ ...draft, sequence: sequence + offset + 1 }));

/**
 * Ends every share whose time is up at `at`. Each ending names whoever shared
 * the tab, since nobody acted. Empty when nothing is due.
 */
export function expireBrowsingSharing(
  record: BrowsingRecord,
  { at, sequence }: Omit<BrowsingDecisionContext, "by">,
): ReadonlyArray<BrowsingEvent> {
  const now = DateTime.toEpochMillis(DateTime.makeUnsafe(at));
  return numbered(
    record.tabs.flatMap((tab): ReadonlyArray<EventDraft> => {
      if (tab.sharing === undefined || isSharedAt(tab, now)) return [];
      const sharing = tab.sharing;
      return [{ _tag: "TabUnshared", by: sharing.by, at, tabId: tab.id, reason: "Expired" }];
    }),
    sequence,
  );
}

export function decideBrowsing(
  record: BrowsingRecord,
  command: BrowsingCommand,
  context: BrowsingDecisionContext,
): BrowsingDecision {
  const result = drafts(record, command, context);
  if (typeof result === "string") return { _tag: "Rejected", reason: result };
  if (result.length === 0) return NOTHING;
  return { _tag: "Events", events: numbered(result, context.sequence) };
}
