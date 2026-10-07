import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountPool, AccountPoolOverview } from "@t3tools/contracts/accountHub";

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
