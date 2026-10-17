/**
 * The folder tree's state, as atoms so each piece recomputes only when what
 * it reads changes: each environment's owners and trees (folders and
 * contexts), where each thread shows (its residents: id, project, archived),
 * how many live below each folder, and each list's threads (every shell
 * update, but an unchanged list keeps its array, so only its list redraws).
 */
import {
  folderThreadCounts,
  threadHomeLookup,
} from "@t3tools/client-runtime/state/signalboxFolders";
import {
  threadStatusOf,
  type FolderStatusCounts,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentContextsAtom } from "../../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { environmentThreadShells } from "../../../state/threads";
import type { SidebarThreadSummary } from "../../../types";
import {
  folderListOfThreads,
  folderOwners,
  sameEntries,
  sameResidents,
  sliceFolderThreads,
  type FolderListKey,
  type FolderOwner,
  type FolderResident,
} from "./folderSidebarModel";
import { folderStatusCountsByNode, type FolderStatusResident } from "./folderStatus";

export interface FolderEnvironmentTree {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly contexts: SignalboxContextsSnapshot;
  readonly owners: ReadonlyArray<FolderOwner>;
}

/** Each loaded folder environment's owners and trees; an unchanged environment keeps its entry. */
export const folderTreesAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<EnvironmentId, FolderEnvironmentTree>>(),
  );
  const contexts = get(environmentContextsAtom);
  const trees = new Map<EnvironmentId, FolderEnvironmentTree>();
  for (const [environmentId, folders] of get(environmentFoldersAtom)) {
    const environmentContexts = contexts.get(environmentId);
    if (folders.snapshot === null || environmentContexts === undefined) continue;
    const kept = previous?.get(environmentId);
    trees.set(
      environmentId,
      kept?.snapshot === folders.snapshot && kept.contexts === environmentContexts
        ? kept
        : {
            environmentId,
            snapshot: folders.snapshot,
            contexts: environmentContexts,
            owners: folderOwners(environmentContexts, folders.snapshot),
          },
    );
  }
  return previous !== undefined && sameEntries(previous, trees) ? previous : trees;
}).pipe(Atom.withLabel("web-folder-trees"));

/** The threads of folder environments, as far as where they show is concerned. */
const folderResidentsAtom = Atom.make((get): ReadonlyArray<FolderResident> => {
  const folders = get(environmentFoldersAtom);
  const residents = get(environmentThreadShells.threadShellsAtom).flatMap((thread) =>
    folders.has(thread.environmentId)
      ? [
          {
            environmentId: thread.environmentId,
            id: thread.id,
            projectId: thread.projectId,
            archivedAt: thread.archivedAt,
          },
        ]
      : [],
  );
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<FolderResident>>());
  return previous !== undefined && sameResidents(previous, residents) ? previous : residents;
}).pipe(Atom.withLabel("web-folder-residents"));

/** Which list each thread shows in. */
const folderListOfAtom = Atom.make((get) => {
  const residents = get(folderResidentsAtom);
  const listOf = new Map<string, FolderListKey>();
  for (const tree of get(folderTreesAtom).values()) {
    const homeOf = threadHomeLookup(tree.snapshot);
    for (const [thread, list] of folderListOfThreads(
      tree.environmentId,
      tree.owners,
      homeOf,
      residents,
    )) {
      listOf.set(thread, list);
    }
  }
  return listOf;
}).pipe(Atom.withLabel("web-folder-list-of"));

/**
 * How many threads live in each folder or below it, per environment. An
 * environment whose counts didn't change keeps its map, so its rows don't redraw.
 */
export const folderCountsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<EnvironmentId, ReadonlyMap<FolderId, number>>>(),
  );
  const residents = get(folderResidentsAtom);
  const counts = new Map<EnvironmentId, ReadonlyMap<FolderId, number>>();
  for (const tree of get(folderTreesAtom).values()) {
    const owned = new Set(tree.owners.flatMap((owner) => owner.context.projectIds));
    const next = folderThreadCounts(
      tree.snapshot,
      residents.filter(
        (thread) => thread.environmentId === tree.environmentId && owned.has(thread.projectId),
      ),
    );
    const kept = previous?.get(tree.environmentId);
    counts.set(tree.environmentId, kept !== undefined && sameEntries(kept, next) ? kept : next);
  }
  return previous !== undefined && sameEntries(previous, counts) ? previous : counts;
}).pipe(Atom.withLabel("web-folder-counts"));

/**
 * signalbox: each folder's threads by state (#670), by folder node key. Every
 * shell update recounts, but a folder whose counts held keeps its object.
 */
const folderStatusCountsMapAtom = Atom.make((get) => {
  const folders = get(environmentFoldersAtom);
  const residents = get(environmentThreadShells.threadShellsAtom).flatMap(
    (thread): ReadonlyArray<FolderStatusResident> =>
      folders.has(thread.environmentId)
        ? [
            {
              environmentId: thread.environmentId,
              id: thread.id,
              projectId: thread.projectId,
              state: threadStatusOf(thread.source).state,
              updatedAt: thread.updatedAt,
            },
          ]
        : [],
  );
  return folderStatusCountsByNode(
    get(folderTreesAtom).values(),
    residents,
    Option.getOrUndefined(get.self<ReadonlyMap<string, FolderStatusCounts>>()),
  );
}).pipe(Atom.withLabel("web-folder-status-counts"));

/** One folder's counts by state; null while no live thread is in it or below. */
export const folderStatusCountsAtom = Atom.family((nodeKey: string) =>
  Atom.make((get) => get(folderStatusCountsMapAtom).get(nodeKey) ?? null).pipe(
    Atom.withLabel(`web-folder-status-counts:${nodeKey}`),
  ),
);

/** Every list's threads, by list key. */
export const folderThreadSlicesAtom = Atom.make((get) =>
  sliceFolderThreads(
    get(environmentThreadShells.threadShellsAtom),
    get(folderListOfAtom),
    Option.getOrUndefined(
      get.self<ReadonlyMap<FolderListKey, ReadonlyArray<SidebarThreadSummary>>>(),
    ),
  ),
).pipe(Atom.withLabel("web-folder-thread-slices"));

const NO_THREADS: ReadonlyArray<SidebarThreadSummary> = [];

/** One list's threads: the same array until one of them changes. */
export const folderThreadSliceAtom = Atom.family((listKey: FolderListKey) =>
  Atom.make((get) => get(folderThreadSlicesAtom).get(listKey) ?? NO_THREADS).pipe(
    Atom.withLabel(`web-folder-thread-slice:${listKey}`),
  ),
);
