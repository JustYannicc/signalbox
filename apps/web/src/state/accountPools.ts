import type { EnvironmentId } from "@t3tools/contracts";
import type {
  AccountPool,
  AccountPoolOverview,
  PoolAccountMethod,
} from "@t3tools/contracts/accountHub";

import { useServerConfigs } from "./entities";
import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const NO_POOLS: ReadonlyArray<AccountPool> = [];
const NO_VIEWS: ReadonlyArray<AccountPoolOverview> = [];

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

/** Whether accounts can join this environment's pools that way; servers that don't say take every way. */
export function usePoolAccountMethods(environmentId: EnvironmentId) {
  const methods =
    useServerConfigs().get(environmentId)?.environment.capabilities.poolAccountMethods;
  return (method: PoolAccountMethod) => !methods || methods.includes(method);
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
