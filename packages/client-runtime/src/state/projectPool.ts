/**
 * signalbox: the pool a project's threads run on. Signalbox Cloud resolves it
 * from the user's tree (the nearest pool above the project) and sends it with
 * the sections snapshot; clients only read it. The picker offers that pool's
 * models, a new thread starts on one of them, and a project whose pool can't
 * run anything shows "needs a pool". Servers that send no pools (self-hosted)
 * leave every provider on offer.
 */
import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { type AccountPoolId, hubInstancePoolId } from "@t3tools/contracts/accountHub";
import type { ResolvedPool, SectionsSnapshot } from "@t3tools/contracts/sections";

type ProviderInstances = Readonly<Record<string, { readonly config?: unknown }>>;

/** A pool a level runs on, however its server says where it's placed (sections or folders). */
export interface PlacedPool {
  readonly poolId: AccountPoolId;
}

/**
 * The pool `projectId`'s threads run on: null when nothing on its chain has
 * one, undefined when the server doesn't resolve pools. Without a project,
 * the top level's.
 */
export function projectPool(
  snapshot: SectionsSnapshot | null,
  projectId: ProjectId | null,
): ResolvedPool | null | undefined {
  const pools = snapshot?.pools;
  if (pools === undefined) return undefined;
  if (projectId === null) return pools.top;
  const entry = pools.projects.find((candidate) => candidate.projectId === projectId);
  return entry === undefined ? pools.top : entry.pool;
}

/** Whether `instanceId` is one of `poolId`'s provider instances. */
export function isPoolInstance(
  providerInstances: ProviderInstances,
  instanceId: string,
  poolId: string,
): boolean {
  return hubInstancePoolId(providerInstances[instanceId]?.config) === poolId;
}

/** Whether a provider can take a turn now. */
const usable = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.auth.status !== "unauthenticated";

/** The provider's default model, preferring built-in models over custom ones. */
const defaultModel = (provider: ServerProvider) =>
  (
    provider.models.find((model) => model.isDefault && !model.isCustom) ??
    provider.models.find((model) => !model.isCustom) ??
    provider.models[0]
  )?.slug;

/**
 * `selection` moved onto the pool: the pool's provider of the same kind with
 * the same model and options, else its first usable provider and that
 * provider's default model. Null when the pool has no usable provider.
 */
function modelSelectionOnPool(input: {
  readonly selection: ModelSelection | null;
  readonly poolId: AccountPoolId;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const candidates = input.providers.filter(
    (provider) =>
      usable(provider) &&
      isPoolInstance(input.providerInstances, provider.instanceId, input.poolId),
  );
  const selection = input.selection;
  if (selection && candidates.some((provider) => provider.instanceId === selection.instanceId)) {
    return selection;
  }
  const current = selection
    ? input.providers.find((provider) => provider.instanceId === selection.instanceId)
    : undefined;
  const sameKind = current && candidates.find((provider) => provider.driver === current.driver);
  if (selection && sameKind) {
    const offersModel =
      sameKind.models.length === 0 ||
      sameKind.models.some((model) => model.slug === selection.model);
    if (offersModel) return { ...selection, instanceId: sameKind.instanceId };
  }
  const target = sameKind ?? candidates[0];
  const model = target && defaultModel(target);
  return target && model ? { instanceId: target.instanceId, model } : null;
}

/**
 * A new thread's model on its project's pool: `selection`, what it would
 * otherwise start on, moved there. Null when the server doesn't resolve
 * pools or the pool can't run anything; the thread then keeps `selection`.
 */
export function projectPoolModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly snapshot: SectionsSnapshot | null;
  readonly projectId: ProjectId | null;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  return poolModelSelection({ ...input, pool: projectPool(input.snapshot, input.projectId) });
}

/** `projectPoolModelSelection` for a pool already resolved, such as a folder's. */
export function poolModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly pool: PlacedPool | null | undefined;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  if (!input.pool) return null;
  return modelSelectionOnPool({
    selection: input.selection,
    poolId: input.pool.poolId,
    providerInstances: input.providerInstances,
    providers: input.providers,
  });
}

/**
 * Why a project's threads can't run: no pool on its chain, or nobody signed
 * in to its pool for any harness (`instanceId` is where to sign in). Null
 * when they can, or the server doesn't resolve pools.
 */
export type PoolNeed =
  | { readonly _tag: "noPool" }
  | {
      readonly _tag: "signIn";
      readonly poolId: AccountPoolId;
      readonly instanceId: ProviderInstanceId | null;
    };

/** What a composer's send button says while its project has a `PoolNeed`. */
export const NEEDS_A_POOL = "Needs a pool";

export function poolNeed(input: {
  readonly pool: PlacedPool | null | undefined;
  readonly providerInstances: ProviderInstances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): PoolNeed | null {
  const { pool } = input;
  if (pool === undefined) return null;
  if (pool === null) return { _tag: "noPool" };
  const own = input.providers.filter((provider) =>
    isPoolInstance(input.providerInstances, provider.instanceId, pool.poolId),
  );
  if (own.some((provider) => usable(provider) && provider.models.length > 0)) return null;
  return { _tag: "signIn", poolId: pool.poolId, instanceId: own[0]?.instanceId ?? null };
}
