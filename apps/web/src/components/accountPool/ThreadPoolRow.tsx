// signalbox: Thread details says which pool the thread runs on, and where that pool is placed.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { Atom } from "effect/reactivity";
import { CircleAlertIcon, LayersIcon } from "lucide-react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { usePoolViews } from "../../state/accountPools";
import { useProject, useThreadShell } from "../../state/entities";
import { type ResolvedPlacedPool, useProjectPool } from "../../state/projectPool";
import { environmentSections } from "../../state/sections";
import { environmentFoldersAtom } from "../../state/signalboxFolders";
import { cn } from "../../lib/utils";
import { THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS } from "../chat/threadDetailsPanelStyles";

const NO_SECTIONS = Atom.make<SectionsSnapshot | null>(null);

/**
 * The level a pool is placed at, as the user knows it: a folder's name, or
 * the top level (Personal, where sections still organize).
 */
function levelName(
  level: ResolvedPlacedPool["from"],
  sections: SectionsSnapshot | null,
  folders: SignalboxFoldersSnapshot | null,
  projectTitle: string | undefined,
): string | undefined {
  switch (level._tag) {
    case "top":
      return folders ? "the top level" : "Personal";
    case "folder":
      return folders?.folders.find((folder) => folder.id === level.folderId)?.name;
    case "section":
      return sections?.sections.find((section) => section.id === level.sectionId)?.name;
    case "project":
      return projectTitle;
  }
}

export function ThreadPoolRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId?: DraftId | undefined;
}) {
  const draftProjectId = useComposerDraftStore((store) =>
    props.draftId ? (store.getDraftSession(props.draftId)?.projectId ?? null) : null,
  );
  const shell = useThreadShell(
    props.draftId ? null : { environmentId: props.environmentId, threadId: props.threadId },
  );
  const projectId: ProjectId | null = draftProjectId ?? shell?.projectId ?? null;
  const environmentFolders = useAtomValue(environmentFoldersAtom).get(props.environmentId);
  const folders = environmentFolders?.snapshot ?? null;
  // Where folders replace sections, their names come from the folders alone.
  const sections = useAtomValue(
    environmentFolders ? NO_SECTIONS : environmentSections.snapshotAtom(props.environmentId),
  );
  const project = useProject(
    projectId === null ? null : { environmentId: props.environmentId, projectId },
  );
  const views = usePoolViews(props.environmentId);
  // A draft runs on the folder it's being started in: its thread id carries that filing.
  const pool = useProjectPool(props.environmentId, projectId, props.threadId);
  // Servers that don't resolve pools have nothing to say here.
  if (pool === undefined) return null;
  if (pool === null) {
    return (
      <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
        <CircleAlertIcon className="size-4 text-warning" />
        <span className="truncate">Needs a pool</span>
      </div>
    );
  }
  const poolName = views.find((view) => view.id === pool.poolId)?.name ?? "its pool";
  const from = levelName(pool.from, sections, folders, project?.title);
  return (
    <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
      <LayersIcon className="size-4 text-muted-foreground" />
      <span className="min-w-0 truncate">
        Runs on {poolName}
        {from ? <span className="text-muted-foreground"> · from {from}</span> : null}
      </span>
    </div>
  );
}
