// signalbox: the pool each project runs on, as its server resolved it, on mobile.
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
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSections } from "../../state/sections";
import { serverEnvironment } from "../../state/server";

const NO_SNAPSHOT = Atom.make<SectionsSnapshot | null>(null);

type ProviderInstances = Readonly<Record<string, { readonly config?: unknown }>>;

function useSectionsSnapshot(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId ? environmentSections.snapshotAtom(environmentId) : NO_SNAPSHOT,
  );
}

/** The pool `projectId`'s threads run on: null for none, undefined where the server doesn't say. */
function useProjectPool(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ResolvedPool | null | undefined {
  return projectPool(useSectionsSnapshot(environmentId), projectId);
}

/**
 * `selection`, the model a new task would otherwise start on, moved onto the
 * pool its project runs on. Null when the server doesn't resolve pools or the
 * pool can't run anything.
 */
export function useProjectPoolModelSelection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection | null;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const snapshot = useSectionsSnapshot(input.environmentId);
  const { projectId, selection, providerInstances, providers } = input;
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
 * `config` with only the providers a thread in `projectId` can pick, and what
 * the project needs before its threads can run.
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
): { readonly config: Config | null | undefined; readonly need: PoolNeed | null } {
  const pool = useProjectPool(environmentId, projectId);
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
 * "Runs on Work · from Client work": the pool a project's threads run on and
 * the level it's placed at. Null where the server doesn't resolve pools.
 */
export function usePoolSourceLabel(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): string | null {
  const snapshot = useSectionsSnapshot(environmentId);
  const project = useProject(environmentId && projectId ? { environmentId, projectId } : null);
  const views = useEnvironmentQuery(
    environmentId ? serverEnvironment.accountPoolViewsLive({ environmentId, input: {} }) : null,
  ).data;
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
