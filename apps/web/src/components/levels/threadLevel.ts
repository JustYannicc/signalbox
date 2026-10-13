/**
 * Where main's real things sit in the level tree: a real thread lives at its
 * project's level unless you moved it in Home (`itemContainers`), a subagent
 * or fork works at its root thread's level (it inherits, it can't be moved on
 * its own), and an automation sits at its project's level. `level` is for
 * labels and agents; `focusLevel` resolves real projects to their section,
 * the way `focusLevelOf` does, because `levels.ts` only learns a project's
 * section once the Home tree renders.
 *
 * The composer's `@` and Thread details read `useThreadLevel`; Pipeline reads
 * `useThreadsInSight` and the waiting automations read
 * `useRealThingInSight`, so hidden levels stay out of sight there too.
 */
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useMemo } from "react";

import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { isInSight, projectSectionId } from "../sidebar/focus/focusLevels";
import { useFocusedLevel, useFocusStore } from "../sidebar/focus/focusStore";
import { statusForThread } from "../sidebar/sections/homeStatus";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { levelForWorkspace, TOP_LEVEL, type LevelKey } from "./levels";

type Placement = Pick<
  ReturnType<typeof useHomeSectionStore.getState>,
  "itemContainers" | "projectSectionOverrides"
>;

export interface RealProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ThingLevels {
  readonly level: LevelKey;
  readonly focusLevel: LevelKey;
}

/** The Home tree's key for a project when it has registered it, else the physical key. */
function projectRefOf(project: RealProject) {
  const level = levelForWorkspace(project.workspaceRoot);
  return {
    projectKey: level ? level.slice("project:".length) : `${project.environmentId}:${project.id}`,
    displayName: project.title,
    workspaceRoot: project.workspaceRoot,
  };
}

export function projectLevels(project: RealProject, placement: Placement): ThingLevels {
  const ref = projectRefOf(project);
  return {
    level: `project:${ref.projectKey}`,
    focusLevel: `section:${projectSectionId(ref, placement.projectSectionOverrides)}`,
  };
}

export function threadLevels(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly lineage: { readonly rootThreadId: ThreadId };
  },
  project: RealProject | null,
  placement: Placement = useHomeSectionStore.getState(),
): ThingLevels {
  const rootKey = scopedThreadKey(
    scopeThreadRef(thread.environmentId, thread.lineage.rootThreadId),
  );
  const moved = placement.itemContainers[rootKey];
  if (moved) return { level: moved, focusLevel: moved };
  return project ? projectLevels(project, placement) : { level: TOP_LEVEL, focusLevel: TOP_LEVEL };
}

/** A server thread's level, and how it inherits it when it's a subagent or fork. */
export function useThreadLevel(
  ref: ScopedThreadRef | null,
): (ThingLevels & { readonly inheritedAs: "fork" | "subagent" | null }) | null {
  const shell = useThreadShell(ref);
  const environmentId = shell?.environmentId ?? null;
  const projectId = shell?.projectId ?? null;
  const projectRef = useMemo(
    () => (environmentId && projectId ? { environmentId, projectId } : null),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  return useMemo(() => {
    if (!shell) return null;
    const levels = threadLevels(shell, project, { itemContainers, projectSectionOverrides });
    return { ...levels, inheritedAs: shell.lineage.relationshipToParent };
  }, [itemContainers, project, projectSectionOverrides, shell]);
}

/**
 * Focus for real threads and automations: `inSight` says whether a thing may
 * draw attention (rows, counts, "still running") under the current Focus. Hidden
 * levels show nothing unless an escalation rule lets the status through; a
 * peek shows everything for a look.
 */
export function useRealThingInSight() {
  const focused = useFocusedLevel();
  const peeking = useFocusStore((state) => state.peeking);
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const lastVisited = useUiStateStore((state) => state.threadLastVisitedAtById);

  const thread = useCallback(
    (shell: EnvironmentThreadShell, project: RealProject | null) => {
      if (peeking || focused === TOP_LEVEL) return true;
      const placement = { itemContainers, projectSectionOverrides };
      const { focusLevel } = threadLevels(shell, project, placement);
      const status = statusForThread(
        shell,
        lastVisited[scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))],
      );
      return isInSight({ levels: [focusLevel], status }, focused, placement);
    },
    [focused, itemContainers, lastVisited, peeking, projectSectionOverrides],
  );

  const automation = useCallback(
    (project: RealProject | null, waiting: boolean) => {
      if (peeking || focused === TOP_LEVEL || project === null) return true;
      const placement = { itemContainers, projectSectionOverrides };
      const { focusLevel } = projectLevels(project, placement);
      return isInSight(
        { levels: [focusLevel], status: waiting ? "input" : null },
        focused,
        placement,
      );
    },
    [focused, itemContainers, peeking, projectSectionOverrides],
  );

  return { thread, automation };
}

/** Pipeline's filter: drops real threads whose level Focus keeps out of sight. */
export function useThreadsInSight() {
  const projects = useProjects();
  const { thread: inSight } = useRealThingInSight();
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  return useCallback(
    <T extends EnvironmentThreadShell>(threads: readonly T[]): T[] =>
      threads.filter((thread) =>
        inSight(thread, projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null),
      ),
    [inSight, projectByKey],
  );
}
