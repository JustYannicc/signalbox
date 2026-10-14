/**
 * signalbox: a workspace path copied from an environment whose filesystem the
 * user can't reach (`localFilesystem: false`, e.g. Signalbox Cloud) is still
 * worth quoting to an agent, but it is not a path on this machine. Copy actions
 * name where the path lives instead of implying it can be opened here.
 */
import type { ContextMenuItem } from "@t3tools/contracts";

/** Where a workspace path lives, or null when it is on a machine the user reaches. */
export function resolveWorkspacePathLocation(input: {
  readonly localFilesystem: boolean;
  readonly environmentLabel: string | null | undefined;
}): string | null {
  if (input.localFilesystem) return null;
  return input.environmentLabel?.trim() || "the server";
}

/** Names `location` on every `copy-path` item: "Path" becomes "Path on Signalbox Cloud". */
export function labelCopyPathItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  location: string | null,
): ReadonlyArray<ContextMenuItem<Id>> {
  if (location === null) return items;
  return items.map((item) => ({
    ...item,
    ...(item.id === "copy-path" ? { label: `${item.label} on ${location}` } : {}),
    ...(item.children ? { children: labelCopyPathItems(item.children, location) } : {}),
  }));
}
