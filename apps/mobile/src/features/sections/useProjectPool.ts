// signalbox: the pool each project runs on, as its server resolved it, on mobile. Where the
// server keeps folders, a thread runs on its home folder's pool instead (`folders/folder-pool.ts`).
import { useAtomValue } from "@effect/atom-react";
import {
  isPoolInstance,
  type PlacedPool,
  poolModelSelection,
  poolNeed,
  type PoolNeed,
  projectPool,
} from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSections } from "../../state/sections";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentFolders } from "../../state/signalboxFolders";
import { folderPoolSourceLabel, poolOfPoolHome, type PoolHome } from "../folders/folder-pool";

export type { PoolHome };

const NO_SNAPSHOT = Atom.make<SectionsSnapshot | null>(null);

type ProviderInstances = Readonly<Record<string, { readonly config?: unknown }>>;

/**
 * The pool the target's threads run on: null for none, undefined where the
 * server doesn't say or hasn't yet. A folders environment resolves it by the
 * target's home once its folders arrive, and never reads sections; any other
 * by the project's place in its sections.
 */
function usePoolSource(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): {
  readonly pool: PlacedPool | null | undefined;
  readonly sections: SectionsSnapshot | null;
  readonly folders: SignalboxFoldersSnapshot | null;
} {
  const folderQuery = useEnvironmentFolders(environmentId);
  const folders = folderQuery.data;
  const sections = useAtomValue(
    environmentId && !folderQuery.supported
      ? environmentSections.snapshotAtom(environmentId)
      : NO_SNAPSHOT,
  );
  const threadId = home !== undefined && "threadId" in home ? home.threadId : undefined;
  const folderId = home !== undefined && "folderId" in home ? home.folderId : undefined;
  const supported = folderQuery.supported;
  return useMemo(() => {
    if (!supported) return { pool: projectPool(sections, projectId), sections, folders: null };
    if (!folders) return { pool: undefined, sections: null, folders: null };
    const target =
      threadId !== undefined ? { threadId } : folderId !== undefined ? { folderId } : undefined;
    return { pool: poolOfPoolHome(folders, projectId, target), sections: null, folders };
  }, [folderId, folders, projectId, sections, supported, threadId]);
}

/**
 * `selection`, the model a new task would otherwise start on, moved onto the
 * pool its project (or, with folders, its home) runs on. Null when the server
 * doesn't resolve pools or the pool can't run anything.
 */
export function useProjectPoolModelSelection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection | null;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Where the new thread will live, where the server keeps folders. */
  readonly home?: PoolHome | undefined;
}): ModelSelection | null {
  const { pool } = usePoolSource(input.environmentId, input.projectId, input.home);
  const { selection, providerInstances, providers } = input;
  return useMemo(
    () => poolModelSelection({ selection, pool, providerInstances, providers }),
    [pool, providerInstances, providers, selection],
  );
}

/** Only `pool`'s providers, or every one where the server doesn't resolve pools. */
function providersOnPool(
  providers: ReadonlyArray<ServerProvider>,
  providerInstances: ProviderInstances,
  pool: PlacedPool | null | undefined,
): ReadonlyArray<ServerProvider> {
  if (pool === undefined) return providers;
  if (pool === null) return [];
  return providers.filter((provider) =>
    isPoolInstance(providerInstances, provider.instanceId, pool.poolId),
  );
}

/**
 * `config` with only the providers a thread in `projectId` (or, with folders,
 * at `home`) can pick, and what it needs before its threads can run.
 */
export function usePoolServerConfig<
  Config extends {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly settings: { readonly providerInstances: ProviderInstances };
  },
>(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  config: Config | null | undefined,
  /** The thread, or where a new one will live, where the server keeps folders. */
  home?: PoolHome,
): { readonly config: Config | null | undefined; readonly need: PoolNeed | null } {
  const { pool } = usePoolSource(environmentId, projectId, home);
  return useMemo(() => {
    if (!config || pool === undefined) return { config, need: null };
    const providers = providersOnPool(config.providers, config.settings.providerInstances, pool);
    return {
      config: { ...config, providers },
      need: poolNeed({ pool, providerInstances: config.settings.providerInstances, providers }),
    };
  }, [config, pool]);
}

/**
 * "Runs on Work · from Client work": the pool a project's threads (or, with
 * folders, the target's) run on and the level it's placed at. Null where the
 * server doesn't resolve pools.
 */
export function usePoolSourceLabel(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  home?: PoolHome,
): string | null {
  const { pool, sections, folders } = usePoolSource(environmentId, projectId, home);
  const project = useProject(environmentId && projectId ? { environmentId, projectId } : null);
  const views = useEnvironmentQuery(
    environmentId ? serverEnvironment.accountPoolViewsLive({ environmentId, input: {} }) : null,
  ).data;
  if (pool === undefined) return null;
  const name = views?.find((view) => view.id === pool?.poolId)?.name;
  if (folders) {
    return folderPoolSourceLabel(folders, poolOfPoolHome(folders, projectId, home), name);
  }
  const placed = projectPool(sections, projectId);
  if (!placed) return "Needs a pool";
  const level = placed.from;
  const from =
    level._tag === "top"
      ? "Personal"
      : level._tag === "section"
        ? sections?.sections.find((section) => section.id === level.sectionId)?.name
        : project?.title;
  const runsOn = name ?? "its pool";
  return from ? `Runs on ${runsOn} · from ${from}` : `Runs on ${runsOn}`;
}
