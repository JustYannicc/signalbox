import type { EnvironmentId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID, poolIdForSourceId } from "@t3tools/contracts/accountHub";
import type { LimitAccount, LimitPool } from "@t3tools/shared/usageLimits";

import { useAccountPools } from "../../state/accountPools";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { AddHubAccountMenu } from "../accountHub/AddHubAccountMenu";
import { UsageLimitsAccountList } from "../usage/UsageLimitsAccountList";

/** Keeps the accounts of each provider pool that `include` accepts, dropping providers left empty. */
const only = (pools: readonly LimitPool[], include: (account: LimitAccount) => boolean) =>
  pools
    .map((pool) => ({ ...pool, accounts: pool.accounts.filter(include) }))
    .filter((pool) => pool.accounts.length > 0);

interface Group {
  readonly key: string;
  readonly title: string;
  /** Where Add account puts new accounts; absent for pools on other environments. */
  readonly add?: { readonly environmentId: EnvironmentId; readonly poolId: string };
  readonly include: (account: LimitAccount) => boolean;
}

const poolKey = (environmentId: string, poolId: string) => `${environmentId}:${poolId}`;
const accountPoolKey = (account: LimitAccount) => {
  const hub = account.hubAccount;
  const poolId = hub ? poolIdForSourceId(hub.sourceId) : null;
  return hub && poolId ? poolKey(hub.environmentId, poolId) : null;
};

/**
 * Accounts on Limits, by account pool and then provider. With one pool it is
 * a single list; with several, each pool gets its own heading. Accounts are
 * added on the environment being looked at (with several selected, the
 * primary one); pools on other environments are listed under their own names.
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
        add: { environmentId, poolId: pool.id },
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

  if (groups.length <= 1 && outside.length === 0) {
    const group = groups[0];
    return (
      <UsageLimitsAccountList
        pools={pools}
        now={now}
        actions={
          environmentId ? (
            <AddHubAccountMenu
              environmentId={environmentId}
              poolId={group?.add?.poolId ?? PERSONAL_POOL_ID}
            />
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
            group.add ? (
              <AddHubAccountMenu
                environmentId={group.add.environmentId}
                poolId={group.add.poolId}
              />
            ) : undefined
          }
        />
      ))}
      {outside.length > 0 ? (
        <UsageLimitsAccountList title="Not in a pool" pools={outside} now={now} />
      ) : null}
    </div>
  );
}
