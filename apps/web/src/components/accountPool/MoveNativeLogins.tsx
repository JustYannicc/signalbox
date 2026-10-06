import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAccountPools } from "../../state/accountPools";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { movableNativeLogins, nativeLoginLabel } from "./nativeLogins";
import { failureText } from "./PoolDialogs";

/**
 * The one-click move of native logins into a pool. Shows nothing once there
 * is nothing left to move.
 */
export function MoveNativeLogins({
  environmentId,
  instanceIds,
  framed = false,
}: {
  readonly environmentId: EnvironmentId;
  /** Only these providers; all movable ones when absent. */
  readonly instanceIds?: ReadonlyArray<ProviderInstanceId>;
  /** Framed as its own group, for the top of a settings page. */
  readonly framed?: boolean;
}) {
  const instances = useEnvironmentSettings(environmentId, (settings) => settings.providerInstances);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const pools = useAccountPools(environmentId);
  const move = useAtomCommand(serverEnvironment.moveNativeLogins, { reportFailure: false });
  const [poolId, setPoolId] = useState<string>(PERSONAL_POOL_ID);
  const [pending, setPending] = useState(false);
  const logins = movableNativeLogins(providers, instances).filter(
    (provider) => !instanceIds || instanceIds.includes(provider.instanceId),
  );
  if (logins.length === 0 || pools.length === 0) return null;
  const pool = pools.find((candidate) => candidate.id === poolId) ?? pools[0]!;

  const run = async () => {
    setPending(true);
    const result = await move({
      environmentId,
      input: { poolId: pool.id, instanceIds: logins.map((provider) => provider.instanceId) },
    });
    setPending(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Could not move the sign-ins",
        description: failureText(result, "Try again."),
      });
      return;
    }
    const { moved, failed } = result.value;
    if (moved.length > 0) {
      toastManager.add({
        type: "success",
        title:
          moved.length === 1
            ? `Moved into ${pool.name}`
            : `${moved.length} moved into ${pool.name}`,
      });
    }
    for (const failure of failed) {
      const provider = logins.find((candidate) => candidate.instanceId === failure.instanceId);
      toastManager.add({
        type: "error",
        title: `Could not move ${provider ? nativeLoginLabel(provider) : failure.instanceId}`,
        description: failure.reason,
      });
    }
  };

  const row = (
    <SettingsRow
      title={
        logins.length === 1 ? "Move this sign-in into a pool" : "Move your sign-ins into a pool"
      }
      description={`${logins.map(nativeLoginLabel).join(", ")} ${logins.length === 1 ? "signs" : "sign"} in on the server itself. In a pool, Signalbox refreshes the login and spreads work across your accounts. Using the same account directly on the server afterwards signs it out of the pool.`}
      control={
        <div className="flex items-center gap-2">
          {pools.length > 1 ? (
            <Select value={pool.id} onValueChange={(value) => value && setPoolId(value)}>
              <SelectTrigger size="sm" aria-label="Pool">
                <SelectValue>
                  {(value: string | null) =>
                    pools.find((candidate) => candidate.id === value)?.name ?? "Pool"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {pools.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button size="sm" disabled={pending} onClick={() => void run()}>
            {pools.length > 1 ? "Move" : `Move into ${pool.name}`}
          </Button>
        </div>
      }
    />
  );
  return framed ? (
    <SettingsGroup divided={false} className="overflow-hidden">
      {row}
    </SettingsGroup>
  ) : (
    row
  );
}
