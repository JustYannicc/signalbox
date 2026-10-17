// signalbox: in-thread Find on mobile (#792), the parts that don't need React Native.
import type { OrchestrationV2SearchThreadInput } from "@t3tools/contracts";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;

export interface ThreadFindTarget {
  readonly entryId: string;
  readonly runId: string | null;
}

/** What a feed row holds that a Find match can name: its id, or the turn items inside it. */
interface FeedRowLike {
  readonly id?: unknown;
  readonly message?: { readonly projectedItem?: { readonly item?: { readonly id?: unknown } } };
  readonly activities?: ReadonlyArray<{
    readonly projectedItem?: { readonly item?: { readonly id?: unknown } };
  }>;
}

function rowHolds(row: FeedRowLike, entryId: string): boolean {
  if (row.id === entryId) return true;
  if (row.message?.projectedItem?.item?.id === entryId) return true;
  return row.activities?.some((activity) => activity.projectedItem?.item?.id === entryId) ?? false;
}

/**
 * The feed row to scroll to for a match: the row holding the entry, else the
 * collapsed run it sits in. -1 when the feed doesn't have it yet.
 */
export function feedIndexForFindTarget(
  rows: ReadonlyArray<unknown>,
  target: ThreadFindTarget,
): number {
  const index = rows.findIndex(
    (row) => typeof row === "object" && row !== null && rowHolds(row, target.entryId),
  );
  if (index !== -1 || target.runId === null) return index;
  const foldId = `run-fold:${target.runId}`;
  return rows.findIndex(
    (row) => typeof row === "object" && row !== null && (row as FeedRowLike).id === foldId,
  );
}

export function formatThreadFindCount(index: number, total: number, counting: boolean): string {
  if (total <= 0) return counting ? "…" : "0/0";
  const clamped = Math.min(Math.max(0, Math.trunc(index)), total - 1);
  return `${clamped + 1}/${total}${counting ? "+" : ""}`;
}
