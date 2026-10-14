// signalbox: a Signalbox Cloud environment's folders, one tree per owner, in the navigation panel.
import { useAtomValue } from "@effect/atom-react";
import { folderTree } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Folder } from "@t3tools/contracts/signalboxFolders";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  folderThreadResidentsAtom,
  useEnvironmentFolders,
  useFolderOwners,
} from "../../state/signalboxFolders";
import { folderFilterKey, folderResidentCounts, parseFolderFilterKey } from "./folder-filter";
import { folderMenuActions, topLevelMenuActions } from "./folder-menus";
import { FolderInstructionsSheet } from "./FolderInstructionsSheet";
import { FolderNodeRow, OwnerTopLevelRow } from "./FolderNavigationRows";
import { useFolderActions } from "./use-folder-actions";

export function FolderNavigationEnvironment(props: {
  readonly environmentId: EnvironmentId;
  /** Shown above the owners when several environments are listed. */
  readonly label: string | null;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const { environmentId, onSelect } = props;
  const folders = useEnvironmentFolders(environmentId);
  const snapshot = folders.data;
  const owners = useFolderOwners(environmentId);
  const residents = useAtomValue(folderThreadResidentsAtom);
  // Names only, so usage updates don't re-render every row.
  const poolViews = useEnvironmentQuery(
    serverEnvironment.accountPoolViewsLive({ environmentId, input: {} }),
  ).data;
  const poolKey = JSON.stringify((poolViews ?? []).map((pool) => [pool.id, pool.name]));
  const pools = useMemo(
    () => (JSON.parse(poolKey) as Array<[string, string]>).map(([id, name]) => ({ id, name })),
    [poolKey],
  );
  const counts = useMemo(() => {
    if (!snapshot) return null;
    const own = residents.filter((resident) => resident.environmentId === environmentId);
    return folderResidentCounts(snapshot, owners, own);
  }, [environmentId, owners, residents, snapshot]);
  const actions = useFolderActions({ environmentId, snapshot });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((folder: Folder) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.add(folder.id);
      return next;
    });
  }, []);
  const selected = parseFolderFilterKey(props.selectedKey);
  const selectedHere = selected?.environmentId === environmentId ? selected.level : null;
  const onSelectFolder = useCallback(
    (folder: Folder) =>
      onSelect(folderFilterKey(environmentId, { _tag: "folder", folderId: folder.id })),
    [environmentId, onSelect],
  );
  const menuFor = useCallback(
    (folder: Folder) => (snapshot ? folderMenuActions({ snapshot, folder, pools }) : []),
    [pools, snapshot],
  );

  return (
    <View className="border-b border-border pb-1 last:border-b-0">
      {props.label ? (
        <AppText className="px-4 pt-3 pb-1 text-xs font-t3-semibold uppercase tracking-wide text-foreground-muted">
          {props.label}
        </AppText>
      ) : null}
      {folders.error !== null && !snapshot ? (
        <View className="flex-row items-center gap-3 px-4 py-3">
          <View className="min-w-0 flex-1">
            <AppText className="text-sm font-t3-medium text-foreground">
              Couldn’t load folders
            </AppText>
            <AppText className="mt-0.5 text-xs text-foreground-muted" numberOfLines={2}>
              {folders.error}
            </AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading folders again"
            className="min-h-10 justify-center rounded-full bg-subtle px-4 active:bg-subtle-strong"
            onPress={folders.refresh}
          >
            <AppText className="text-sm font-t3-medium text-primary">Retry</AppText>
          </Pressable>
        </View>
      ) : null}
      {!snapshot || !owners ? (
        folders.error === null ? (
          <AppText className="px-4 py-3 text-xs text-foreground-muted">Loading folders…</AppText>
        ) : null
      ) : (
        owners.contexts.map((owner) => {
          const tree = folderTree(snapshot, owner.id);
          return (
            <View key={owner.id} className="pt-1">
              <OwnerTopLevelRow
                name={owner.name}
                count={counts?.top.get(owner.id) ?? 0}
                selected={selectedHere?._tag === "top" && selectedHere.ownerId === owner.id}
                actions={topLevelMenuActions({ personal: owner.kind === "personal" })}
                onSelect={() =>
                  onSelect(folderFilterKey(environmentId, { _tag: "top", ownerId: owner.id }))
                }
                onAction={(event) => actions.onTopLevelAction(owner, event)}
              />
              {tree.map((node) => (
                <FolderNodeRow
                  key={node.folder.id}
                  node={node}
                  depth={1}
                  ancestorPath=""
                  counts={counts?.folders ?? EMPTY_COUNTS}
                  selectedFolderId={selectedHere?._tag === "folder" ? selectedHere.folderId : null}
                  collapsed={collapsed}
                  menuFor={menuFor}
                  onSelect={onSelectFolder}
                  onToggle={onToggle}
                  onAction={actions.onFolderAction}
                />
              ))}
              {tree.length === 0 ? (
                <AppText className="pr-4 pb-2 pl-[62px] text-xs text-foreground-muted">
                  No folders yet. New folder is in the ⋯ menu.
                </AppText>
              ) : null}
            </View>
          );
        })
      )}
      {actions.editing ? (
        <FolderInstructionsSheet
          key={`${actions.editing.level._tag}:${actions.editing.name}`}
          editing={actions.editing}
          onSave={actions.saveInstructions}
          onClose={actions.closeEditor}
        />
      ) : null}
    </View>
  );
}

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();
