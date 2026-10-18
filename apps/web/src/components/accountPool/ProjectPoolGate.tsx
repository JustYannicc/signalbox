// signalbox: the composer offers only the pool its thread runs on, and says when it needs one.
import { isPoolInstance, poolNeed, type PoolNeed } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { usePoolViews } from "../../state/accountPools";
import { useProjectPool, useProjectPoolModelSelection } from "../../state/projectPool";
import { ComposerControl, type ComposerControlSize } from "../chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { needsPoolCopy } from "./needsPoolCopy";

/**
 * The entries a thread in `projectId` can pick, its pool's only, and what it
 * needs before it can run. `threadId`: where folders do, its home decides the
 * pool. Every entry where the server doesn't resolve pools.
 */
export function useProjectPoolEntries(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providerInstances: Readonly<Record<string, { readonly config?: unknown }>>,
  threadId?: ThreadId | null,
): {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly need: PoolNeed | null;
  readonly mapModelSelectionToPool: ReturnType<typeof useProjectPoolModelSelection>;
} {
  const pool = useProjectPool(environmentId, projectId, threadId);
  const mapModelSelectionToPool = useProjectPoolModelSelection();
  return (() => {
    const own = pool
      ? entries.filter((entry) => isPoolInstance(providerInstances, entry.instanceId, pool.poolId))
      : pool === null
        ? []
        : entries;
    const need = poolNeed({
      pool,
      providerInstances,
      providers: own.map((entry) => entry.snapshot),
    });
    return { entries: own, need, mapModelSelectionToPool };
  })();
}

/** What the project needs and the composer's copy for it; null when it needs nothing. */
export function useNeedsPool(
  environmentId: EnvironmentId | null,
  need: PoolNeed | null,
): NeedsPool | null {
  // Only sign-in needs the pool name; views change with usage, so only it subscribes.
  const views = usePoolViews(need?._tag === "signIn" ? environmentId : null);
  const poolName =
    need?._tag === "signIn" ? views.find((view) => view.id === need.poolId)?.name : undefined;
  return need === null ? null : { need, ...needsPoolCopy(need, poolName) };
}

export type NeedsPool = ReturnType<typeof needsPoolCopy> & { readonly need: PoolNeed };

/**
 * The composer's one action while its project needs a pool: sign in to the
 * pool it runs on, or choose a pool when nothing above it has one.
 */
export function NeedsPoolControl(props: {
  readonly pool: NeedsPool;
  readonly size: ComposerControlSize;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
}) {
  const navigate = useNavigate();
  const { need, action, why } = props.pool;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={props.size}
            className="shrink-0"
            data-chat-needs-pool="true"
            aria-label={`Needs a pool. ${why} ${action}.`}
            onClick={() => {
              if (need._tag === "signIn" && need.instanceId !== null) {
                props.onOpenProviderSetup(need.instanceId);
              } else {
                void navigate({ to: "/settings/pools" });
              }
            }}
          />
        }
      >
        <CircleAlertIcon className="text-warning" />
        <span>Needs a pool</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="text-foreground">{action}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{why}</TooltipPopup>
    </Tooltip>
  );
}
