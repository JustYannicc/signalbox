// signalbox: in-thread Find on mobile (#792), the parts that don't need React Native.
import type { OrchestrationV2SearchThreadInput } from "@t3tools/contracts";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;

export interface ThreadFindTarget {
  readonly entryId: string;
  readonly runId: string | null;
}

export interface ThreadFindRevealRequest {
  readonly key: string;
  readonly threadKey: string;
  readonly target: ThreadFindTarget;
}

export type ThreadFindRevealAction =
  | { readonly type: "scroll"; readonly index: number }
  | { readonly type: "expand-run"; readonly runId: string }
  | { readonly type: "expand-work-row"; readonly rowId: string; readonly anchorKey: string }
  | {
      readonly type: "expand-work-group";
      readonly groupId: string;
      readonly anchorKey: string;
    }
  | { readonly type: "missing" };

/** What a feed row holds that a Find match can name: its id, or the turn items inside it. */
interface FeedRowLike {
  readonly id?: unknown;
  readonly itemId?: unknown;
  readonly type?: unknown;
  readonly runId?: unknown;
  readonly groupId?: unknown;
  readonly expanded?: unknown;
  readonly message?: { readonly projectedItem?: { readonly item?: FeedItemLike } };
  readonly activities?: ReadonlyArray<FeedActivityLike>;
}

interface FeedActivityLike {
  readonly id?: unknown;
  readonly prominent?: unknown;
  readonly projectedItem?: { readonly item?: FeedItemLike };
}

interface FeedItemLike {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
}

function asFeedRow(value: unknown): FeedRowLike | null {
  return typeof value === "object" && value !== null ? (value as FeedRowLike) : null;
}

function rowHolds(row: FeedRowLike, entryId: string): boolean {
  if (row.id === entryId) return true;
  if ((row.type === "html-render" || row.type === "mcp-app") && row.itemId === entryId) {
    return true;
  }
  if (row.message?.projectedItem?.item?.id === entryId) return true;
  return row.activities?.some((activity) => activity.projectedItem?.item?.id === entryId) ?? false;
}

/** The visible feed row holding the match. Returns -1 while it is collapsed or absent. */
export function feedIndexForFindTarget(
  rows: ReadonlyArray<unknown>,
  target: ThreadFindTarget,
): number {
  return rows.findIndex(
    (row) => typeof row === "object" && row !== null && rowHolds(row, target.entryId),
  );
}

/** Reveal a hidden target through the feed's existing run and work-group disclosures. */
export function threadFindRevealAction(
  rows: ReadonlyArray<unknown>,
  sourceFeed: ReadonlyArray<unknown>,
  target: ThreadFindTarget,
  expandedWorkRows: Readonly<Record<string, boolean>> = {},
): ThreadFindRevealAction {
  const index = feedIndexForFindTarget(rows, target);
  if (index !== -1) {
    const row = asFeedRow(rows[index]);
    const activity = row?.activities?.find(
      (candidate) => candidate.projectedItem?.item?.id === target.entryId,
    );
    if (
      activity?.prominent !== true &&
      typeof activity?.id === "string" &&
      !expandedWorkRows[activity.id] &&
      typeof row?.id === "string"
    ) {
      return { type: "expand-work-row", rowId: activity.id, anchorKey: row.id };
    }
    return { type: "scroll", index };
  }
  if (target.runId === null) return { type: "missing" };

  const runFold = findFeedRow(rows, (row) => row.type === "run-fold" && row.runId === target.runId);
  if (runFold && runFold.expanded !== true) {
    return { type: "expand-run", runId: target.runId };
  }

  const groupId = workGroupIdForTarget(sourceFeed, target.entryId);
  if (groupId === null) return { type: "missing" };
  const workToggle = findFeedRow(
    rows,
    (row) => row.type === "work-toggle" && row.groupId === groupId,
  );
  if (!workToggle || workToggle.expanded === true || typeof workToggle.id !== "string") {
    return { type: "missing" };
  }
  return { type: "expand-work-group", groupId, anchorKey: workToggle.id };
}

function findFeedRow(
  rows: ReadonlyArray<unknown>,
  matches: (row: FeedRowLike) => boolean,
): FeedRowLike | null {
  for (const value of rows) {
    const row = asFeedRow(value);
    if (row !== null && matches(row)) return row;
  }
  return null;
}

function workGroupIdForTarget(sourceFeed: ReadonlyArray<unknown>, entryId: string): string | null {
  // Match appendActivityGroupRows so Find opens only the disclosure containing this item.
  for (const row of sourceFeed) {
    const source = asFeedRow(row);
    if (source === null || source.type !== "activity-group" || !Array.isArray(source.activities)) {
      continue;
    }

    let groupAnchorId: string | null = null;
    for (const activity of source.activities) {
      const item = activity.projectedItem?.item;
      const failedError = item?.type === "error" && item.status === "failed";
      if (activity.prominent === true || failedError) {
        groupAnchorId = null;
        continue;
      }
      if (typeof activity.id !== "string") continue;
      groupAnchorId ??= activity.id;
      if (item?.id !== entryId) continue;

      if (item?.type === "notification") return null;
      return `work-group:${groupAnchorId}`;
    }
  }
  return null;
}

export function formatThreadFindCount(index: number, total: number, counting: boolean): string {
  if (total <= 0) return counting ? "…" : "0/0";
  const clamped = Math.min(Math.max(0, Math.trunc(index)), total - 1);
  return `${clamped + 1}/${total}${counting ? "+" : ""}`;
}
