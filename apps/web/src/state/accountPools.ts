import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountPool } from "@t3tools/contracts/accountHub";

import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const NO_POOLS: ReadonlyArray<AccountPool> = [];

/** The account pools of an environment, kept live; empty until it connects. */
export function useAccountPools(environmentId: EnvironmentId | null | undefined) {
  const environment = useEnvironment(environmentId ?? null);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    environmentId && connected
      ? serverEnvironment.accountPoolsLive({ environmentId, input: {} })
      : null,
  );
  return query.data ?? NO_POOLS;
}
