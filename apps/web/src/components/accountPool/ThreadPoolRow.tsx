// signalbox: Thread details says which pool the thread runs on, and where that pool is placed.
import { useAtomValue } from "@effect/atom-react";
import { projectPool } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { PoolLevel, SectionsSnapshot } from "@t3tools/contracts/sections";
import { CircleAlertIcon, LayersIcon } from "lucide-react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { usePoolViews } from "../../state/accountPools";
import { useProject, useThreadShell } from "../../state/entities";
import { environmentSections } from "../../state/sections";
import { cn } from "../../lib/utils";
import { THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS } from "../chat/threadDetailsPanelStyles";

/** The level a pool is placed at, as the user knows it: Personal at the top, else its folder's name. */
function levelName(
  level: PoolLevel,
  snapshot: SectionsSnapshot | null,
  projectTitle: string | undefined,
): string | undefined {
  switch (level._tag) {
    case "top":
      return "Personal";
    case "section":
      return snapshot?.sections.find((section) => section.id === level.sectionId)?.name;
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
  const snapshot = useAtomValue(environmentSections.snapshotAtom(props.environmentId));
  const project = useProject(
    projectId === null ? null : { environmentId: props.environmentId, projectId },
  );
  const views = usePoolViews(props.environmentId);
  const pool = projectPool(snapshot, projectId);
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
  const from = levelName(pool.from, snapshot, project?.title);
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
