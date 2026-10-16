import {
  activeBrowsingTab,
  BROWSING_PREVIEW_EPOCH,
  type BrowsingState,
  browsingTabSnapshot,
  samePageUrl,
} from "@t3tools/client-runtime/browsing";
import type { PreviewListResult, PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import type { BrowsingCommand, BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";

/**
 * How the browser panel follows a thread's synced record (#585), and how the
 * panel's own changes go back to it. Pure, so the sync wiring in
 * `threadBrowsingSync.ts` stays a thin loop around these decisions.
 */

/**
 * A record tab as the panel's session, with what only this device knows
 * (viewport, zoom, colours, profile, back/forward, a failed load) on top.
 */
export function browsingSessionSnapshot(
  threadId: ThreadId,
  tab: BrowsingTab,
  local: PreviewSessionSnapshot | undefined,
): PreviewSessionSnapshot {
  const base = browsingTabSnapshot(threadId, tab);
  if (local === undefined) return base;
  const failed = local.navStatus._tag === "LoadFailed" && samePageUrl(local.navStatus.url, tab.url);
  return {
    ...local,
    ...base,
    navStatus: failed ? local.navStatus : base.navStatus,
    canGoBack: local.canGoBack,
    canGoForward: local.canGoForward,
    // Never older than what the panel holds, or its reconcile keeps the stale session.
    updatedAt: local.updatedAt > base.updatedAt ? local.updatedAt : base.updatedAt,
  };
}

export function browsingPreviewList(
  threadId: ThreadId,
  state: BrowsingState,
  local: Readonly<Record<string, PreviewSessionSnapshot>>,
): PreviewListResult {
  return {
    sessions: state.record.tabs.map((tab) => browsingSessionSnapshot(threadId, tab, local[tab.id])),
    serverEpoch: BROWSING_PREVIEW_EPOCH,
    revision: state.sequence,
  };
}

/**
 * Whether the panel would show the same thing for both: the tabs, their
 * order, addresses and titles, and the active tab. Positions land every few
 * seconds and change none of it.
 */
export function samePanelRecord(a: BrowsingState, b: BrowsingState): boolean {
  if (a.record.activeTabId !== b.record.activeTabId) return false;
  if (a.record.tabs === b.record.tabs) return true;
  if (a.record.tabs.length !== b.record.tabs.length) return false;
  return a.record.tabs.every((tab, index) => {
    const other = b.record.tabs[index]!;
    return tab.id === other.id && tab.url === other.url && tab.title === other.title;
  });
}

/**
 * This device's own change the record hasn't caught up with yet: commands in
 * flight, then the sequence the last one landed at. While held, the record
 * doesn't overwrite it, so an echo of an older change can't yank the panel back.
 */
export interface LocalIntent {
  readonly inflight: number;
  readonly untilSequence: number;
}

export const NO_LOCAL_INTENT: LocalIntent = { inflight: 0, untilSequence: 0 };

export const localIntentHeld = (intent: LocalIntent, sequence: number) =>
  intent.inflight > 0 || sequence < intent.untilSequence;

export const localIntentStarted = (intent: LocalIntent): LocalIntent => ({
  ...intent,
  inflight: intent.inflight + 1,
});

/** `sequence` is where the command left the record, or null when it failed. */
export const localIntentSettled = (intent: LocalIntent, sequence: number | null): LocalIntent => ({
  inflight: Math.max(0, intent.inflight - 1),
  untilSequence:
    sequence === null ? intent.untilSequence : Math.max(intent.untilSequence, sequence),
});

const recordActiveTabId = (state: BrowsingState) => activeBrowsingTab(state.record)?.id ?? null;

/** The tab to switch to because someone else activated it, if any. */
export function remoteActivation(
  state: BrowsingState,
  localActiveTabId: string | null,
  intent: LocalIntent,
): string | null {
  if (state.you === null || localIntentHeld(intent, state.sequence)) return null;
  const active = recordActiveTabId(state);
  return active === null || active === localActiveTabId ? null : active;
}

/** The command for a tab this device switched to, unless the record already has it. */
export function localActivation(
  state: BrowsingState,
  localActiveTabId: string | null,
): BrowsingCommand | null {
  if (state.you === null || localActiveTabId === null) return null;
  if (!state.record.tabs.some((tab) => tab.id === localActiveTabId)) return null;
  return recordActiveTabId(state) === localActiveTabId
    ? null
    : { _tag: "Activate", tabId: localActiveTabId };
}

interface PanelSurface {
  readonly id: string;
  readonly kind: string;
  readonly resourceId?: string | null;
}

const browserTabId = (surface: PanelSurface): string | null =>
  surface.kind === "preview" && typeof surface.resourceId === "string" ? surface.resourceId : null;

/** The panel's browser tabs, in tab-strip order. */
export function browserSurfaceTabIds(surfaces: ReadonlyArray<PanelSurface>): string[] {
  return surfaces.flatMap((surface) => {
    const tabId = browserTabId(surface);
    return tabId === null ? [] : [tabId];
  });
}

/** How a panel change touched its browser tabs: added or removed some, only reordered them, or neither. */
export function browserSurfaceChange(
  before: ReadonlyArray<PanelSurface>,
  after: ReadonlyArray<PanelSurface>,
): "set" | "order" | null {
  const previous = before.filter((surface) => surface.kind === "preview").map((s) => s.id);
  const next = after.filter((surface) => surface.kind === "preview").map((s) => s.id);
  if (previous.length !== next.length || previous.some((id) => !next.includes(id))) return "set";
  return previous.some((id, index) => id !== next[index]) ? "order" : null;
}

/**
 * The `moveSurface` calls that put the panel's browser tabs in record order.
 * Browser tabs keep the slots they hold among terminals and files; only who
 * sits in them changes.
 */
export function browserSurfaceMoves(
  surfaces: ReadonlyArray<PanelSurface>,
  recordTabIds: ReadonlyArray<string>,
): Array<{ readonly surfaceId: string; readonly toIndex: number }> {
  const rank = new Map(recordTabIds.map((tabId, index) => [tabId, index]));
  const slots: number[] = [];
  const ranked: PanelSurface[] = [];
  surfaces.forEach((surface, index) => {
    const tabId = browserTabId(surface);
    if (tabId === null || !rank.has(tabId)) return;
    slots.push(index);
    ranked.push(surface);
  });
  ranked.sort((a, b) => rank.get(browserTabId(a)!)! - rank.get(browserTabId(b)!)!);
  const target = surfaces.slice();
  slots.forEach((slot, index) => {
    target[slot] = ranked[index]!;
  });
  const current = surfaces.slice();
  const moves: Array<{ surfaceId: string; toIndex: number }> = [];
  target.forEach((surface, toIndex) => {
    if (current[toIndex]?.id === surface.id) return;
    const fromIndex = current.findIndex((entry) => entry.id === surface.id);
    current.splice(toIndex, 0, ...current.splice(fromIndex, 1));
    moves.push({ surfaceId: surface.id, toIndex });
  });
  return moves;
}

/**
 * The `Move` commands that give the record the panel's tab order. A drag
 * moves one tab, so this is usually one command: tabs on the longest run
 * already in record order stay, the rest go before the tab that follows them.
 */
export function tabMovesForLocalOrder(
  recordTabIds: ReadonlyArray<string>,
  localTabIds: ReadonlyArray<string>,
): BrowsingCommand[] {
  const present = new Set(localTabIds);
  const recordRank = new Map(
    recordTabIds.filter((tabId) => present.has(tabId)).map((tabId, index) => [tabId, index]),
  );
  const local = localTabIds.filter((tabId) => recordRank.has(tabId));
  const ranks = local.map((tabId) => recordRank.get(tabId)!);
  const kept = longestIncreasingRun(ranks);
  const moves: BrowsingCommand[] = [];
  for (let index = local.length - 1; index >= 0; index -= 1) {
    if (kept.has(index)) continue;
    moves.push({ _tag: "Move", tabId: local[index]!, beforeTabId: local[index + 1] ?? null });
  }
  return moves;
}

/** Indexes of one longest strictly increasing subsequence. */
function longestIncreasingRun(values: ReadonlyArray<number>): Set<number> {
  const tails: number[] = [];
  const previous: number[] = Array.from({ length: values.length }, () => -1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const kept = new Set<number>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) kept.add(index);
  return kept;
}
