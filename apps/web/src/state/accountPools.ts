import type { EnvironmentId } from "@t3tools/contracts";
import type {
  AccountPool,
  AccountPoolAdvice,
  AccountPoolOverview,
  PoolFeature,
} from "@t3tools/contracts/accountHub";

import { useServerConfigs } from "./entities";
import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const NO_POOLS: ReadonlyArray<AccountPool> = [];
const NO_VIEWS: ReadonlyArray<AccountPoolOverview> = [];
const NO_ADVICE: ReadonlyArray<AccountPoolAdvice> = [];

function useConnectedEnvironmentId(environmentId: EnvironmentId | null | undefined) {
  const environment = useEnvironment(environmentId ?? null);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return environmentId && connected ? environmentId : null;
}

/** The account pools of an environment with their backing, kept live; for pool admins. */
export function useAccountPools(environmentId: EnvironmentId | null | undefined) {
  const connectedId = useConnectedEnvironmentId(environmentId);
  const query = useEnvironmentQuery(
    connectedId
      ? serverEnvironment.accountPoolsLive({ environmentId: connectedId, input: {} })
      : null,
  );
  return query.data ?? NO_POOLS;
}

/** A pool's name, once its environment has listed it. */
export function usePoolName(environmentId: EnvironmentId | null | undefined, poolId: string) {
  return useAccountPools(environmentId).find((pool) => pool.id === poolId)?.name;
}

/** Whether this environment's pools can do that; servers that don't say can do everything. */
export function usePoolFeatures(environmentId: EnvironmentId) {
  const features = useServerConfigs().get(environmentId)?.environment.capabilities.poolFeatures;
  return (feature: PoolFeature) => !features || features.includes(feature);
}

/** Every pool's overview in an environment, kept live; any session may read it. Empty until it connects. */
export function usePoolViews(environmentId: EnvironmentId | null | undefined) {
  const connectedId = useConnectedEnvironmentId(environmentId);
  const query = useEnvironmentQuery(
    connectedId
      ? serverEnvironment.accountPoolViewsLive({ environmentId: connectedId, input: {} })
      : null,
  );
  return query.data ?? NO_VIEWS;
}

/**
 * What each pool's usage history advises, kept live; for pool admins. Empty
 * until it connects, and on environments whose pools don't keep history.
 */
export function usePoolAdvice(environmentId: EnvironmentId | null | undefined) {
  const connectedId = useConnectedEnvironmentId(environmentId);
  const configs = useServerConfigs();
  const features = connectedId
    ? configs.get(connectedId)?.environment.capabilities.poolFeatures
    : undefined;
  const advises = !features || features.includes("advice");
  const query = useEnvironmentQuery(
    connectedId && advises
      ? serverEnvironment.accountPoolAdviceLive({ environmentId: connectedId, input: {} })
      : null,
  );
  return query.data ?? NO_ADVICE;
}
