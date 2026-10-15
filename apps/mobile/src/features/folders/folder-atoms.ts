// signalbox: what the folder panel reads, as atoms that keep their value until it changes.
import { folderThreadCounts } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
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
