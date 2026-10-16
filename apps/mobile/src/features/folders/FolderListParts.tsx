// signalbox: what the thread list shows while it's filtered to a folder.
import { Platform } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";

import { withFolderFilterOption } from "./folder-filter";

export { withFolderFilterOption };

/** The filter chip's project scopes, with the shown folder among them. */
export function scopeFilterOptions(
  scopes: ReadonlyArray<{ readonly key: string; readonly title: string }>,
  folder: { readonly key: string; readonly label: string } | null,
) {
  return withFolderFilterOption(
    scopes.map((scope) => ({ key: scope.key, label: scope.title })),
    folder,
  );
}

/** The empty Home list while it shows a folder with no threads of its own. */
export function FolderEmptyState(props: { readonly label: string }) {
  return (
    <EmptyState
      title={`No threads in ${props.label}`}
      detail="Choose another folder or start a new task here."
      variant={Platform.OS === "android" ? "plain" : undefined}
    />
  );
}
