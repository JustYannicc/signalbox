// signalbox: the pool each project runs on, as its server resolved it, on mobile. Where the
// server keeps folders, a thread runs on its home folder's pool instead (`folders/folder-pool.ts`).
import { useAtomValue } from "@effect/atom-react";
import {
  isPoolInstance,
  poolNeed,
  type PoolNeed,
  projectPool,
  projectPoolModelSelection,
} from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { ResolvedPool, SectionsSnapshot } from "@t3tools/contracts/sections";
import type { FolderResolvedPool } from "@t3tools/contracts/signalboxFolders";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSections } from "../../state/sections";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentFolders } from "../../state/signalboxFolders";
import {
  folderPoolOf,
  folderPoolSourceLabel,
  poolSnapshotFor,
  type PoolHome,
} from "../folders/folder-pool";

export type { PoolHome };

const NO_SNAPSHOT = Atom.make<SectionsSnapshot | null>(null);

type ProviderInstances = Readonly<Record<string, { readonly config?: unknown }>>;

function useSectionsSnapshot(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId ? environmentSections.snapshotAtom(environmentId) : NO_SNAPSHOT,
  );
}

/**
 * What the pool helpers read for a target: the sections snapshot and its
 * project, or, once the server's folders arrive, a snapshot holding the pool
 * of the target's home folder, read with no project. `folderPool` is that pool.
 */
function usePoolSource(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): {
  readonly snapshot: SectionsSnapshot | null;
  readonly projectId: ProjectId | null;
  readonly folderPool?: FolderResolvedPool | null;
} {
  const sections = useSectionsSnapshot(environmentId);
  const folders = useEnvironmentFolders(environmentId).data;
  const threadId = home !== undefined && "threadId" in home ? home.threadId : undefined;
  const folderId = home !== undefined && "folderId" in home ? home.folderId : undefined;
  return useMemo(() => {
    if (!folders) return { snapshot: sections, projectId };
    const target =
      threadId !== undefined ? { threadId } : folderId !== undefined ? { folderId } : undefined;
    const folderPool = folderPoolOf(folders, projectId, target);
    return { snapshot: poolSnapshotFor(folderPool), projectId: null, folderPool };
  }, [folderId, folders, projectId, sections, threadId]);
}

/** The pool the target's threads run on: null for none, undefined where the server doesn't say. */
function useProjectPool(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): ResolvedPool | null | undefined {
  const source = usePoolSource(environmentId, projectId, home);
  return projectPool(source.snapshot, source.projectId);
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
  readonly home?: PoolHome;
}): ModelSelection | null {
  const { snapshot, projectId } = usePoolSource(input.environmentId, input.projectId, input.home);
  const { selection, providerInstances, providers } = input;
  return useMemo(
    () =>
      projectPoolModelSelection({ selection, snapshot, projectId, providerInstances, providers }),
    [projectId, providerInstances, providers, selection, snapshot],
  );
}

/** Only `pool`'s providers, or every one where the server doesn't resolve pools. */
function providersOnPool(
  providers: ReadonlyArray<ServerProvider>,
  providerInstances: ProviderInstances,
  pool: ResolvedPool | null | undefined,
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
  const pool = useProjectPool(environmentId, projectId, home);
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
  const snapshot = useSectionsSnapshot(environmentId);
  const folders = useEnvironmentFolders(environmentId).data;
  const source = usePoolSource(environmentId, projectId, home);
  const project = useProject(environmentId && projectId ? { environmentId, projectId } : null);
  const views = useEnvironmentQuery(
    environmentId ? serverEnvironment.accountPoolViewsLive({ environmentId, input: {} }) : null,
  ).data;
  if (folders && source.folderPool !== undefined) {
    const folderPool = source.folderPool;
    const name = views?.find((view) => view.id === folderPool?.poolId)?.name;
    return folderPoolSourceLabel(folders, folderPool, name);
  }
  const pool = projectPool(snapshot, projectId);
  if (pool === undefined) return null;
  if (pool === null) return "Needs a pool";
  const name = views?.find((view) => view.id === pool.poolId)?.name ?? "its pool";
  const level = pool.from;
  const from =
    level._tag === "top"
      ? "Personal"
      : level._tag === "section"
        ? snapshot?.sections.find((section) => section.id === level.sectionId)?.name
        : project?.title;
  return from ? `Runs on ${name} · from ${from}` : `Runs on ${name}`;
}
