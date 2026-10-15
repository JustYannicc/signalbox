// signalbox: chat and task kinds in a thread's menus (#46).
import { otherThreadKind } from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";

import { threadKindFlipLabel } from "./threadKind.logic";

export type ThreadKindMenuId = "make-chat" | "make-task";

const MENU_ID: Record<ThreadKind, ThreadKindMenuId> = { chat: "make-chat", task: "make-task" };
const ICON: Record<ThreadKind, string> = { chat: "message-circle", task: "list-todo" };

/** The entry that flips a thread that is `kind` now. */
export function threadKindMenuItem(
  kind: ThreadKind,
  options: { readonly disabled?: boolean } = {},
): ContextMenuItem<ThreadKindMenuId> {
  const to = otherThreadKind(kind);
  return {
    id: MENU_ID[to],
    label: threadKindFlipLabel(kind),
    icon: ICON[to],
    ...(options.disabled ? { disabled: true } : {}),
  };
}

/** The kind a chosen entry makes the thread; null for every other entry. */
export function threadKindFromMenuId(clicked: string): ThreadKind | null {
  return clicked === "make-chat" ? "chat" : clicked === "make-task" ? "task" : null;
}

/**
 * A thread menu with its kind: the flip right after Rename, and Archive
 * reading "Done" on a task. Unchanged where the thread has no kind.
 */
export function withThreadKindItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  kind: ThreadKind | null,
): ReadonlyArray<ContextMenuItem<Id | ThreadKindMenuId>> {
  if (kind === null) return items;
  return items.flatMap((item): ReadonlyArray<ContextMenuItem<Id | ThreadKindMenuId>> => {
    if (item.id === "rename") return [item, threadKindMenuItem(kind)];
    if (item.id === "archive" && kind === "task")
      return [{ ...item, label: "Done", icon: "check" }];
    return [item];
  });
}
