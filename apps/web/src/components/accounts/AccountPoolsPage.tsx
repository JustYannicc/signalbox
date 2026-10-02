/**
 * Usage › Accounts: pooled capacity per harness, advice from your pace, and
 * the pools you own or connected to (shared Drive-style). UI prototype on
 * placeholder data (see accountPoolsFixtures.ts); groups come from Plugins.
 */
import { formatDuration } from "@t3tools/shared/usageLimits";
import { PlusIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { CURRENT_PERSON_ID } from "../multiplayer/multiplayerFixtures";
import { ACCOUNT_GROUPS_FROM_PLUGINS } from "../plugins/groupsFixtures";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  ACCOUNT_POOLS,
  INITIALLY_CONNECTED,
  QUOTAS_UPDATED_AT,
  USAGE_PACE,
  isUsable,
} from "./accountPoolsFixtures";
import { POOL_HARNESSES, notifyAccountsComingSoon, poolCapacity } from "./accountPoolsModel";
import { PoolBlock } from "./PoolBlock";
import { PoolCapacityOverview } from "./PoolCapacityOverview";
import { adviseFromUsage } from "./usageAdvice";
import { UsageAdviceList } from "./UsageAdviceList";
import { UsageTabs } from "./UsageTabs";

const GROUPS_BY_ID = new Map(ACCOUNT_GROUPS_FROM_PLUGINS.map((group) => [group.id, group]));

export function AccountPoolsPage() {
  // Countdowns are read once per visit; a live ticking clock would repaint every row.
  const [now] = useState(() => Date.now());
  const [connected, setConnected] = useState<ReadonlySet<string>>(INITIALLY_CONNECTED);
  const capacities = useMemo(() => {
    const usable = ACCOUNT_POOLS.filter((pool) => isUsable(pool, connected)).flatMap(
      (pool) => pool.accounts,
    );
    return POOL_HARNESSES.map((harness) => poolCapacity(harness, usable)).filter(
      (capacity) => capacity.accounts.length > 0,
    );
  }, [connected]);
  const advice = capacities.map((capacity) =>
    adviseFromUsage(capacity, USAGE_PACE[capacity.harness], now),
  );
  const yours = ACCOUNT_POOLS.filter((pool) => pool.ownerId === CURRENT_PERSON_ID);
  const shared = ACCOUNT_POOLS.filter((pool) => pool.ownerId !== CURRENT_PERSON_ID);
  const setPoolConnected = (poolId: string, next: boolean) =>
    setConnected((current) => {
      const updated = new Set(current);
      if (next) updated.add(poolId);
      else updated.delete(poolId);
      return updated;
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current>
                <UsageTabs current="accounts" />
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums md:block">
              Updated {formatDuration(now - QUOTAS_UPDATED_AT)} ago
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh quotas"
              onClick={() => notifyAccountsComingSoon("Refreshing quotas")}
            >
              <RefreshIcon size="sm" refreshing={false} />
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => notifyAccountsComingSoon("Adding accounts")}
            >
              <PlusIcon aria-hidden />
              Add account
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-8">
            <PoolCapacityOverview capacities={capacities} now={now} />
            <UsageAdviceList advice={advice} />
            <PoolList title="Your pools" id="pools-yours">
              {yours.map((pool) => (
                <PoolBlock
                  key={pool.id}
                  pool={pool}
                  owned
                  connected
                  onConnectedChange={() => undefined}
                  groupsById={GROUPS_BY_ID}
                  now={now}
                />
              ))}
            </PoolList>
            <PoolList title="Shared with you" id="pools-shared">
              {shared.map((pool) => (
                <PoolBlock
                  key={pool.id}
                  pool={pool}
                  owned={false}
                  connected={connected.has(pool.id)}
                  onConnectedChange={(next) => setPoolConnected(pool.id, next)}
                  groupsById={GROUPS_BY_ID}
                  now={now}
                />
              ))}
            </PoolList>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function PoolList({
  title,
  id,
  children,
}: {
  readonly title: string;
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-sm font-medium text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}
