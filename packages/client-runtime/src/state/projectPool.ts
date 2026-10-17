import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
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
  provider.status !== "error" &&
  provider.availability !== "unavailable" &&
  provider.auth.status !== "unauthenticated";

/**
 * `selection` moved onto the pool: the pool's provider of the same kind with
 * the same model and options, else an economical model
 * from a usable provider. Null when the pool has no usable provider.
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
  return resolveInitialModelSelection({
    providers: sameKind
      ? [sameKind, ...candidates.filter((provider) => provider !== sameKind)]
      : candidates,
  });
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
 * Why a project's threads can't run: no pool, no signed-in account, no model
 * in the pool catalog, or a failed pool read. Null when they can run or the
 * server doesn't resolve pools.
 */
export type PoolNeed =
  | { readonly _tag: "noPool" }
  | {
      readonly _tag: "signIn";
      readonly poolId: AccountPoolId;
      readonly instanceId: ProviderInstanceId | null;
    }
  | { readonly _tag: "noModels"; readonly poolId: AccountPoolId; readonly message: string }
  | { readonly _tag: "unavailable"; readonly poolId: AccountPoolId; readonly message: string };

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
  const unavailable = own.find(
    (provider) =>
      provider.unavailableReason !== undefined ||
      (provider.status === "error" && provider.auth.status === "unknown"),
  );
  if (unavailable) {
    return {
      _tag: "unavailable",
      poolId: pool.poolId,
      message:
        unavailable.message ??
        unavailable.unavailableReason ??
        "The pool is unavailable right now. Try again.",
    };
  }
  const noModels = own.find(
    (provider) =>
      provider.models.length === 0 &&
      provider.status === "warning" &&
      provider.auth.status === "authenticated" &&
      provider.unavailableReason === undefined,
  );
  if (noModels) {
    return {
      _tag: "noModels",
      poolId: pool.poolId,
      message:
        noModels.message ?? "This pool's accounts serve no models right now. Try again shortly.",
    };
  }
  return { _tag: "signIn", poolId: pool.poolId, instanceId: own[0]?.instanceId ?? null };
}
