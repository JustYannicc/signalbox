// signalbox: a Signalbox Cloud environment's folders, one tree per owner, in the navigation panel.
import { useAtomValue } from "@effect/atom-react";
import { folderTree } from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { useEnvironmentFolders, useFolderOwners } from "../../state/signalboxFolders";
import { useEnvironmentHasNotes } from "../../state/signalboxNotes";
import { NotesSheet } from "../notes/NotesSheet";
import { useOpenThread } from "../threads/use-open-thread";
import { folderCountsAtom, folderPoolChoicesAtom } from "./folder-atoms";
import { folderFilterKey, parseFolderFilterKey } from "./folder-filter";
import { folderMenuActions, topLevelMenuActions } from "./folder-menus";
import { FolderInstructionsSheet } from "./FolderInstructionsSheet";
import { FolderNodeRow, OwnerTopLevelRow } from "./FolderNavigationRows";
import { useFolderActions } from "./use-folder-actions";

const PERSONAL_TOP_ACTIONS = topLevelMenuActions({ personal: true });
const PERSONAL_TOP_ACTIONS_WITH_NOTES = topLevelMenuActions({ personal: true, notes: true });
const ORGANIZATION_TOP_ACTIONS = topLevelMenuActions({ personal: false });

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
  const counts = useAtomValue(folderCountsAtom(environmentId));
  const pools = useAtomValue(folderPoolChoicesAtom(environmentId));
  const actions = useFolderActions({ environmentId, snapshot, pools });
  const hasNotes = useEnvironmentHasNotes(environmentId);
  const openThread = useOpenThread();
  const openNoteThread = useCallback(
    (threadId: ThreadId) => openThread(environmentId, threadId),
    [environmentId, openThread],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<FolderId>>(() => new Set());
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
  const onSelectTop = useCallback(
    (owner: SignalboxContext) =>
      onSelect(folderFilterKey(environmentId, { _tag: "top", ownerId: owner.id })),
    [environmentId, onSelect],
  );
  // Every folder's menu, built once per snapshot and pool list.
  const menus = useMemo(
    () =>
      new Map<FolderId, MenuAction[]>(
        (snapshot?.folders ?? []).map((folder) => [
          folder.id,
          snapshot ? folderMenuActions({ snapshot, folder, pools, notes: hasNotes }) : [],
        ]),
      ),
    [hasNotes, pools, snapshot],
  );
  const trees = useMemo(
    () =>
      snapshot && owners
        ? owners.contexts.map((owner) => ({ owner, tree: folderTree(snapshot, owner.id) }))
        : null,
    [owners, snapshot],
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
      {trees === null ? (
        folders.error === null ? (
          <AppText className="px-4 py-3 text-xs text-foreground-muted">Loading folders…</AppText>
        ) : null
      ) : (
        trees.map(({ owner, tree }) => (
          <View key={owner.id} className="pt-1">
            <OwnerTopLevelRow
              owner={owner}
              selected={selectedHere?._tag === "top" && selectedHere.ownerId === owner.id}
              actions={
                owner.kind !== "personal"
                  ? ORGANIZATION_TOP_ACTIONS
                  : hasNotes
                    ? PERSONAL_TOP_ACTIONS_WITH_NOTES
                    : PERSONAL_TOP_ACTIONS
              }
              onSelect={onSelectTop}
              onAction={actions.onTopLevelAction}
            />
            {tree.map((node) => (
              <FolderNodeRow
                key={node.folder.id}
                node={node}
                depth={1}
                ancestorPath=""
                counts={counts}
                selectedFolderId={selectedHere?._tag === "folder" ? selectedHere.folderId : null}
                collapsed={collapsed}
                menus={menus}
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
        ))
      )}
      {actions.editing ? (
        <FolderInstructionsSheet
          key={`${actions.editing.level._tag}:${actions.editing.name}`}
          editing={actions.editing}
          onSave={actions.saveInstructions}
          onClose={actions.closeEditor}
        />
      ) : null}
      {actions.notes && hasNotes ? (
        <NotesSheet
          key={actions.notes.level._tag === "folder" ? actions.notes.level.folderId : "top"}
          open={actions.notes}
          onClose={actions.closeNotes}
          onOpenThread={openNoteThread}
        />
      ) : null}
    </View>
  );
}
