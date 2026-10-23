import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import { POOL_INSTANCE_KINDS, poolInstanceEntry } from "@t3tools/contracts/accountHub";
import type {
  ModelSelection,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";
import { takesTurns } from "@t3tools/shared/poolUsage";

import type { PoolEntry } from "../../../pool/poolViews.ts";
import { CLOUD_POOL_KINDS } from "./routing.ts";
import { harnessModels, poolServerProvider } from "./providerCatalog.ts";

/** Each pool's provider instances, for `ServerConfig.providers`. */
export const poolProviders = (
  pools: ReadonlyArray<PoolEntry>,
  checkedAt: string,
  manifest: ModelManifestCatalogs,
): ReadonlyArray<ServerProvider> =>
  pools.flatMap(({ pool, source, models }) =>
    CLOUD_POOL_KINDS.map((kind) => {
      const [instanceId, config] = poolInstanceEntry(kind, {
        id: pool.id,
        name: pool.personal ? undefined : pool.name,
      });
      const signedIn = source.accounts.some(
        (account) => account.driver === POOL_INSTANCE_KINDS[kind].driver && takesTurns(account),
      );
      const availableModels = harnessModels(kind, models, manifest);
      const registeredLocally = models.some(
        (model) =>
          model.registration?.kind === "local" &&
          availableModels.some((available) => available.slug === model.id),
      );
      return poolServerProvider({
        kind,
        instanceId,
        displayName: config.displayName ?? POOL_INSTANCE_KINDS[kind].displayName,
        signedIn,
        registeredLocally,
        ...(source.error && (signedIn || source.accounts.length === 0)
          ? { unavailableReason: source.error }
          : {}),
        models: availableModels,
        checkedAt,
      });
    }),
  );

export const readyProviders = (providers: ReadonlyArray<ServerProvider>) =>
  providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated",
  );

/** The economical initial selection from pools ready to run. */
export const poolDefaultModelSelection = (
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null => {
  const eligible = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated" &&
      (provider.status !== "error" ||
        (provider.auth.status === "unknown" &&
          provider.unavailableReason !== undefined &&
          provider.models.length > 0)),
  );
  return (
    resolveInitialModelSelection({
      providers: eligible.filter((provider) => provider.status === "ready"),
    }) ?? resolveInitialModelSelection({ providers: eligible })
  );
};

/** Settings list each instance with its pool, which is how clients group instances by pool. */
export const poolProviderInstances = (
  pools: ReadonlyArray<PoolEntry["pool"]>,
): Record<ProviderInstanceId, ProviderInstanceConfig> =>
  Object.fromEntries(
    pools.flatMap((pool) =>
      CLOUD_POOL_KINDS.map((kind) =>
        poolInstanceEntry(kind, { id: pool.id, name: pool.personal ? undefined : pool.name }),
      ),
    ),
  );
