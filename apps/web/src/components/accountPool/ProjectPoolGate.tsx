// signalbox: the composer offers only the pool its project runs on, and says when it needs one.
import { isPoolInstance, poolNeed, type PoolNeed } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { usePoolViews } from "../../state/accountPools";
import { useProjectPool } from "../../state/projectPool";
import { ComposerControl, type ComposerControlSize } from "../chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The entries a thread in `projectId` can pick, its pool's only, and what the
 * project needs before its threads can run. Every entry where the server
 * doesn't resolve pools.
 */
export function useProjectPoolEntries(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providerInstances: Readonly<Record<string, { readonly config?: unknown }>>,
): { readonly entries: ReadonlyArray<ProviderInstanceEntry>; readonly need: PoolNeed | null } {
  const pool = useProjectPool(environmentId, projectId);
  return useMemo(() => {
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
    return { entries: own, need };
  }, [entries, pool, providerInstances]);
}

/** Why sending is blocked while the project needs a pool. */
export const NEEDS_A_POOL = "This folder needs a pool.";

/**
 * The composer's one action while its project needs a pool: sign in to the
 * pool it runs on, or choose a pool when nothing above it has one.
 */
export function NeedsPoolControl(props: {
  readonly environmentId: EnvironmentId | null;
  readonly need: PoolNeed;
  readonly size: ComposerControlSize;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
}) {
  const navigate = useNavigate();
  const views = usePoolViews(props.environmentId);
  const { need } = props;
  const poolName =
    need._tag === "signIn" ? views.find((view) => view.id === need.poolId)?.name : undefined;
  const action = need._tag === "signIn" ? `Sign in to ${poolName ?? "its pool"}` : "Choose a pool";
  const why =
    need._tag === "signIn"
      ? "Nobody is signed in to this folder's pool yet."
      : "Nothing above this folder has a pool.";
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
