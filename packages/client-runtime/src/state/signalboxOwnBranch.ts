/**
 * signalbox: git actions for a thread that works on its own branch, on an environment without
 * `worktrees` (Signalbox Cloud). Every turn commits to that branch, so its working tree is never
 * dirty and Commit could never run. Push and opening a pull request stay. Web and mobile both
 * build their menus from upstream's resolvers and pass them through these.
 */

/** The git actions menu without Commit. */
export function ownBranchMenuItems<Item extends { readonly id: string }>(
  items: ReadonlyArray<Item>,
): Array<Item> {
  return items.filter((item) => item.id !== "commit");
}

/**
 * The quick action, with Commit's idle states (busy, up to date, no status) named after the one
 * thing left to do on the branch: push it. A runnable Commit needs a dirty tree, so it never
 * reaches here.
 */
export function ownBranchQuickAction<
  Action extends { readonly label: string; readonly kind: string },
>(action: Action): Action {
  return action.kind === "show_hint" && action.label === "Commit"
    ? { ...action, label: "Push" }
    : action;
}
