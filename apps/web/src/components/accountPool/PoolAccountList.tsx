import type { EnvironmentId } from "@t3tools/contracts";
import {
  type AccountPool,
  PERSONAL_POOL_ID,
  poolIdForSourceId,
} from "@t3tools/contracts/accountHub";
import type { LimitAccount, LimitPool } from "@t3tools/shared/usageLimits";

import { useAccountPools } from "../../state/accountPools";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { AddHubAccountMenu } from "../accountHub/AddHubAccountMenu";
import { UsageLimitsAccountList } from "../usage/UsageLimitsAccountList";
import { NewPoolButton, PoolActionsMenu } from "./PoolActions";

/** Keeps the accounts of each provider pool that `include` accepts, dropping providers left empty. */
const only = (pools: readonly LimitPool[], include: (account: LimitAccount) => boolean) =>
  pools
    .map((pool) => ({ ...pool, accounts: pool.accounts.filter(include) }))
    .filter((pool) => pool.accounts.length > 0);

interface Group {
  readonly key: string;
  readonly title: string;
  /** The pool on the environment being looked at; absent for pools only other environments report. */
  readonly own?: { readonly environmentId: EnvironmentId; readonly pool: AccountPool };
  readonly include: (account: LimitAccount) => boolean;
}

const poolKey = (environmentId: string, poolId: string) => `${environmentId}:${poolId}`;
const accountPoolKey = (account: LimitAccount) => {
  const hub = account.hubAccount;
  const poolId = hub ? poolIdForSourceId(hub.sourceId) : null;
  return hub && poolId ? poolKey(hub.environmentId, poolId) : null;
};

/**
 * Accounts on Limits, by account pool and then provider. Each pool of the
 * environment being looked at (with several selected, the primary one) gets
 * its heading with Add account and its own actions, and New pool follows
 * them; pools on other environments are listed under their own names.
 */
export function PoolAccountList({
  pools,
  now,
  environmentIds,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const primary = usePrimaryEnvironmentId();
  const environmentId =
    environmentIds.length === 1
      ? environmentIds[0]
      : primary && environmentIds.includes(primary)
        ? primary
        : environmentIds[0];
  const accountPools = useAccountPools(environmentId);

  // Every pool of this environment, even an empty one, so accounts can be added to it.
  const groups: Group[] = environmentId
    ? accountPools.map((pool) => ({
        key: poolKey(environmentId, pool.id),
        title: pool.name,
        own: { environmentId, pool },
        include: (account) => accountPoolKey(account) === poolKey(environmentId, pool.id),
      }))
    : [];
  // Then pools that only other environments report, named as their hub reports them.
  const known = new Set(groups.map((group) => group.key));
  for (const account of pools.flatMap((pool) => pool.accounts)) {
    const key = accountPoolKey(account);
    if (!key || known.has(key)) continue;
    known.add(key);
    groups.push({
      key,
      title: account.sourceLabel ?? "Pool",
      include: (candidate) => accountPoolKey(candidate) === key,
    });
  }
  const outside = only(pools, (account) => accountPoolKey(account) === null);

  // Not connected yet, or nothing pooled anywhere: just the accounts.
  if (groups.length === 0) {
    return (
      <UsageLimitsAccountList
        pools={pools}
        now={now}
        actions={
          environmentId ? (
            <AddHubAccountMenu environmentId={environmentId} poolId={PERSONAL_POOL_ID} />
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <UsageLimitsAccountList
          key={group.key}
          title={group.title}
          pools={only(pools, group.include)}
          now={now}
          actions={
            group.own ? (
              <span className="flex items-center gap-1.5">
                <AddHubAccountMenu
                  environmentId={group.own.environmentId}
                  poolId={group.own.pool.id}
                />
                <PoolActionsMenu environmentId={group.own.environmentId} pool={group.own.pool} />
              </span>
            ) : undefined
          }
        />
      ))}
      {outside.length > 0 ? (
        <UsageLimitsAccountList title="Not in a pool" pools={outside} now={now} />
      ) : null}
      {/* Only once the environment has listed its pools, so only for those who manage them. */}
      {environmentId && accountPools.length > 0 ? (
        <div>
          <NewPoolButton environmentId={environmentId} variant="ghost-muted" />
        </div>
      ) : null}
    </div>
  );
}
