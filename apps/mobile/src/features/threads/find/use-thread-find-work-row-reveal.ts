import { useEffect, type RefObject } from "react";

import type { ThreadFindWorkRowRevealRequest } from "./thread-find-model";

interface WorkList {
  getState(): { readonly data: ReadonlyArray<{ readonly id: string }> };
  scrollToIndex(input: {
    readonly index: number;
    readonly animated: boolean;
    readonly viewPosition: number;
  }): Promise<void>;
}

/** A work group has its own capped viewport; scrolling its parent cannot reveal a row inside it. */
export function useThreadFindWorkRowReveal(input: {
  readonly request: ThreadFindWorkRowRevealRequest | null | undefined;
  readonly rows: ReadonlyArray<{ readonly id: string }>;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly loaded: boolean;
  readonly listRef: RefObject<WorkList | null>;
  readonly onBeforeScroll: () => void;
  readonly onRevealed: ((key: string) => void) | undefined;
}) {
  const { request, expandedRows, loaded, listRef, onBeforeScroll, onRevealed } = input;
  const rowId =
    request && input.rows.some((row) => row.id === request.rowId) ? request.rowId : null;
  useEffect(() => {
    const list = listRef.current;
    if (!loaded || !request || rowId === null || !expandedRows[rowId] || !list) return;
    const index = list.getState().data.findIndex((row) => row.id === rowId);
    if (index === -1) return;
    let current = true;
    onBeforeScroll();
    void list
      .scrollToIndex({ index, animated: false, viewPosition: 0 })
      .then(() => {
        if (current) onRevealed?.(request.key);
      })
      .catch(() => {
        // A superseded or unmounted list leaves the request available for its next mount.
      });
    return () => {
      current = false;
    };
  }, [loaded, request, rowId, expandedRows, listRef, onBeforeScroll, onRevealed]);
  return rowId;
}
