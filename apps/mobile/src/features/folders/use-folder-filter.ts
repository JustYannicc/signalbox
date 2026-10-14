// signalbox: the thread list's folder filter, and where a new task shown in it starts.
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentFolders, useFolderOwners } from "../../state/signalboxFolders";
import { useHomeListOptions } from "../home/home-list-options";
import {
  type FolderStart,
  filterLevelName,
  folderStart,
  isAtLevel,
  parseFolderFilterKey,
  withFolderFilterOption,
} from "./folder-filter";

interface Located {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface FolderFilter {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Whether a thread lives right in the folder. */
  readonly includes: (thread: Located & { readonly id: ThreadId }) => boolean;
  /**
   * Whether a task that isn't a thread yet does: a queued one by the thread
   * it will create, a draft by its project.
   */
  readonly includesTask: (
    task: Located & { readonly message?: { readonly threadId: ThreadId } },
  ) => boolean;
}

/** The folders and owners of the environment a filter key names. */
function useFolderKeyData(selectedKey: string | null) {
  const environmentId = parseFolderFilterKey(selectedKey)?.environmentId ?? null;
  return {
    snapshot: useEnvironmentFolders(environmentId).data,
    owners: useFolderOwners(environmentId),
  };
}

/** The folder `selectedKey` names, once its environment has sent its folders; else null. */
export function useFolderFilter(selectedKey: string | null): FolderFilter | null {
  const { snapshot, owners } = useFolderKeyData(selectedKey);
  return useMemo(() => {
    const parsed = parseFolderFilterKey(selectedKey);
    if (!snapshot || !owners || !parsed || selectedKey === null) return null;
    const label = filterLevelName(snapshot, owners, parsed.level);
    if (label === null) return null;
    const includes = (resident: Located & { readonly id: ThreadId | null }) =>
      resident.environmentId === parsed.environmentId &&
      isAtLevel(snapshot, owners, parsed.level, resident);
    return {
      key: selectedKey,
      environmentId: parsed.environmentId,
      label,
      includes,
      includesTask: (task) => includes({ ...task, id: task.message?.threadId ?? null }),
    };
  }, [owners, selectedKey, snapshot]);
}

/** `threads` that live right in the shown folder; all of them without one. */
function threadsInFolder<Thread extends Located & { readonly id: ThreadId }>(
  filter: FolderFilter | null,
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> {
  return filter === null ? threads : threads.filter(filter.includes);
}

/** `tasks` that will live right in the shown folder; all of them without one. */
function tasksInFolder<
  Task extends Located & { readonly message?: { readonly threadId: ThreadId } },
>(filter: FolderFilter | null, tasks: ReadonlyArray<Task>): ReadonlyArray<Task> {
  return filter === null ? tasks : tasks.filter(filter.includesTask);
}

/**
 * The thread list's folder filter and the threads and tasks it shows. Each
 * list keeps its array while nothing it reads changes.
 */
export function useFolderScope<
  Thread extends Located & { readonly id: ThreadId },
  Task extends Located & { readonly message?: { readonly threadId: ThreadId } },
>(selectedKey: string | null, threads: ReadonlyArray<Thread>, tasks: ReadonlyArray<Task>) {
  const filter = useFolderFilter(selectedKey);
  const scopedThreads = useMemo(() => threadsInFolder(filter, threads), [filter, threads]);
  const pendingTasks = useMemo(() => tasksInFolder(filter, tasks), [filter, tasks]);
  return { filter, threads: scopedThreads, pendingTasks };
}

/** The thread list's filter choices with the shown folder among them, so it stays selected. */
export function useFolderFilterOptions<
  Option extends { readonly key: string; readonly label: string },
>(options: ReadonlyArray<Option>, filter: FolderFilter | null) {
  return useMemo(() => withFolderFilterOption(options, filter), [filter, options]);
}

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/** Where a new task starts while the thread list shows a folder; null otherwise. */
export function useNewTaskFolderStart(): FolderStart | null {
  const selectedKey = useHomeListOptions(NO_ENVIRONMENTS).options.selectedProjectKey;
  const { snapshot, owners } = useFolderKeyData(selectedKey);
  return useMemo(() => {
    const parsed = parseFolderFilterKey(selectedKey);
    return snapshot && parsed
      ? folderStart(snapshot, owners, parsed.environmentId, parsed.level)
      : null;
  }, [owners, selectedKey, snapshot]);
}
