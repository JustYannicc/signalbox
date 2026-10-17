/**
 * Command palette entries for the scratch pad: the one where the open thread (or
 * draft) lives, and the top level's.
 */
import { useAtomValue } from "@effect/atom-react";
import { homeOfThread } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { StickyNoteIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { environmentFoldersAtom } from "../../state/signalboxFolders";
import { notesEnvironmentsAtom } from "../../state/signalboxNotes";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { openNotes } from "./notesSheetStore";

const topLevelItem = (
  environmentId: EnvironmentId,
  title: string,
  value: string,
): CommandPaletteActionItem => ({
  kind: "action",
  value,
  searchTerms: ["scratch pad", "notes", "top level notes", "jot", "scratch note"],
  title,
  icon: <StickyNoteIcon className={ITEM_ICON_CLASS} />,
  run: async () => openNotes({ environmentId, home: { _tag: "top" } }),
});

export function useNotesPaletteItems(): Array<CommandPaletteActionItem> {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const shell = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const environments = useAtomValue(notesEnvironmentsAtom);
  const folders = useAtomValue(environmentFoldersAtom);

  const thread = shell
    ? { environmentId: shell.environmentId, threadId: shell.id, projectId: shell.projectId }
    : draft
      ? { environmentId: draft.environmentId, threadId: draft.threadId, projectId: draft.projectId }
      : null;
  if (thread && environments.has(thread.environmentId)) {
    const snapshot = folders.get(thread.environmentId)?.snapshot;
    const home = snapshot
      ? homeOfThread(snapshot, { id: thread.threadId, projectId: thread.projectId })
      : null;
    const folder = home === null ? undefined : snapshot?.folders.find((f) => f.id === home);
    if (home === null || folder === undefined) {
      return [topLevelItem(thread.environmentId, "Scratch pad", "action:notes")];
    }
    return [
      {
        kind: "action",
        value: "action:notes",
        searchTerms: ["scratch pad", "notes", "jot", folder.name],
        title: "Scratch pad",
        description: folder.name,
        icon: <StickyNoteIcon className={ITEM_ICON_CLASS} />,
        run: async () =>
          openNotes({
            environmentId: thread.environmentId,
            home: { _tag: "folder", folderId: folder.id },
          }),
      },
      topLevelItem(thread.environmentId, "Scratch pad at the top level", "action:notes-top-level"),
    ];
  }
  // Nowhere in particular: the top level's pad, once per environment that keeps notes.
  return [...environments].map((environmentId) =>
    topLevelItem(environmentId, "Scratch pad", `action:notes:${environmentId}`),
  );
}
