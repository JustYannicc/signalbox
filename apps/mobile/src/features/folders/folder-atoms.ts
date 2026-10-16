// signalbox: what the folder panel reads, as atoms that keep their value until it changes.
import { folderThreadCounts } from "@t3tools/client-runtime/state/signalboxFolders";
import {
  folderStatusRollups,
  folderStatusSummary,
  threadStatusOf,
  type ThreadStatusState,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { folderEnvironmentsAtom, folderThreadResidentsAtom } from "../../state/signalboxFolders";
import { ownedResidents } from "./folder-filter";
import type { PoolChoice } from "./folder-menus";

const NO_POOLS: ReadonlyArray<PoolChoice> = [];
const NO_COUNTS: ReadonlyMap<FolderId, number> = new Map();

const samePools = (left: ReadonlyArray<PoolChoice>, right: ReadonlyArray<PoolChoice>) =>
  left.length === right.length &&
  left.every((pool, index) => pool.id === right[index]!.id && pool.name === right[index]!.name);

const sameCounts = (left: ReadonlyMap<FolderId, number>, right: ReadonlyMap<FolderId, number>) =>
  left.size === right.size && [...right].every(([id, count]) => left.get(id) === count);

/**
 * The pools a folder can run on, by name. Usage updates rewrite the pool
 * views often; this keeps its array until a pool comes, goes or is renamed.
 */
export const folderPoolChoicesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<PoolChoice> => {
    const views = Option.getOrNull(
      AsyncResult.value(get(serverEnvironment.accountPoolViewsLive({ environmentId, input: {} }))),
    );
    const pools = (views ?? NO_POOLS).map((view) => ({ id: view.id, name: view.name }));
    const previous = Option.getOrUndefined(get.self<ReadonlyArray<PoolChoice>>());
    return previous !== undefined && samePools(previous, pools) ? previous : pools;
  }).pipe(Atom.withLabel(`signalbox-folder-pool-choices:${environmentId}`)),
);

/**
 * How many threads live in each of the environment's folders or below it
 * (`folderThreadCounts`), the same map until a count changes.
 */
export const folderCountsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<FolderId, number> => {
    const environment = get(folderEnvironmentsAtom).get(environmentId);
    if (environment === undefined) return NO_COUNTS;
    const residents = get(folderThreadResidentsAtom).filter(
      (resident) => resident.environmentId === environmentId,
    );
    const counts = folderThreadCounts(
      environment.snapshot,
      ownedResidents(environment.owners, residents),
    );
    const previous = Option.getOrUndefined(get.self<ReadonlyMap<FolderId, number>>());
    return previous !== undefined && sameCounts(previous, counts) ? previous : counts;
  }).pipe(Atom.withLabel(`signalbox-folder-counts:${environmentId}`)),
);

interface StatusResident {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly state: ThreadStatusState;
  readonly updatedAt: string;
}

const sameStatusResidents = (
  left: ReadonlyArray<StatusResident>,
  right: ReadonlyArray<StatusResident>,
) =>
  left.length === right.length &&
  left.every((resident, index) => {
    const other = right[index]!;
    return (
      resident.environmentId === other.environmentId &&
      resident.id === other.id &&
      resident.projectId === other.projectId &&
      resident.state === other.state
    );
  });

/**
 * The folder threads with their status state (#670). Streaming turns rewrite
 * shells many times a second; this keeps its array until a thread comes, goes,
 * moves or changes state. `updatedAt` only orders roll-up highlights, which
 * mobile doesn't show, so it may lag.
 */
const folderStatusResidentsAtom = Atom.make((get) => {
  const residents = get(environmentThreadShells.navigationThreadShellsAtom).map(
    (thread): StatusResident => ({
      environmentId: thread.environmentId,
      id: thread.id,
      projectId: thread.projectId,
      state: threadStatusOf(thread.source).state,
      updatedAt: thread.updatedAt,
    }),
  );
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<StatusResident>>());
  return previous !== undefined && sameStatusResidents(previous, residents) ? previous : residents;
}).pipe(Atom.withLabel("signalbox-folder-status-residents"));

const NO_SUMMARIES: ReadonlyMap<FolderId, string> = new Map();

const sameSummaries = (left: ReadonlyMap<FolderId, string>, right: ReadonlyMap<FolderId, string>) =>
  left.size === right.size && [...right].every(([id, summary]) => left.get(id) === summary);

/**
 * Each folder's status roll-up as one quiet line, "2 working · 1 waiting"
 * (`folderStatusSummary`), counting threads in it or below. Folders where
 * nothing moves have no entry. The same map until a line changes.
 */
export const folderStatusSummariesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<FolderId, string> => {
    const environment = get(folderEnvironmentsAtom).get(environmentId);
    if (environment === undefined) return NO_SUMMARIES;
    const residents = get(folderStatusResidentsAtom).filter(
      (resident) => resident.environmentId === environmentId,
    );
    const summaries = new Map<FolderId, string>();
    for (const [folderId, rollup] of folderStatusRollups(
      environment.snapshot,
      ownedResidents(environment.owners, residents),
    )) {
      const summary = folderStatusSummary(rollup.counts);
      if (summary !== null) summaries.set(folderId, summary);
    }
    const previous = Option.getOrUndefined(get.self<ReadonlyMap<FolderId, string>>());
    return previous !== undefined && sameSummaries(previous, summaries) ? previous : summaries;
  }).pipe(Atom.withLabel(`signalbox-folder-status-summaries:${environmentId}`)),
);
