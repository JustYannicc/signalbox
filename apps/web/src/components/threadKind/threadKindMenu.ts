/**
 * signalbox: kind entries for menus built at open time. Threads whose
 * environment keeps no kinds get none.
 */
import { otherThreadKind } from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import {
  flipThreadKind,
  readCanChangeThreadKind,
  readThreadKind,
} from "../../state/signalboxThreadKinds";
import {
  threadKindFromMenuId,
  threadKindMenuItem,
  type ThreadKindMenuId,
} from "./threadKindMenu.logic";

/** The flip entry for a menu that lists its own items. */
export function threadKindMenuItems(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<ThreadKindMenuId>> {
  const kind = readThreadKind(threadRef);
  if (kind === null) return [];
  return [
    threadKindMenuItem(kind, { disabled: !readCanChangeThreadKind(threadRef.environmentId) }),
  ];
}

/** Runs a chosen kind entry; false when `clicked` is some other entry. */
export function selectThreadKindMenuItem(threadRef: ScopedThreadRef, clicked: string): boolean {
  const to = threadKindFromMenuId(clicked);
  if (to === null) return false;
  void flipThreadKind(threadRef, otherThreadKind(to));
  return true;
}
