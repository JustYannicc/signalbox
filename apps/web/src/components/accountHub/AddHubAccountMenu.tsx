import type { EnvironmentId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon, LayersIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { usePoolAccountMethods, usePoolName } from "../../state/accountPools";
import { PoolNameDialog } from "../accountPool/PoolDialogs";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { AddHubAccountDialog } from "./AddHubAccountDialog";
import { AddPoolApiKeyDialog } from "./AddPoolApiKeyDialog";
import { HUB_INSTANCES, type HubAccountKind } from "./hubInstances";

/** "Add account" for one pool: pick the provider and sign in, or start another pool. */
export function AddHubAccountMenu({
  environmentId,
  poolId = PERSONAL_POOL_ID,
}: {
  readonly environmentId: EnvironmentId;
  readonly poolId?: string;
}) {
  const navigate = useNavigate();
  const offers = usePoolAccountMethods(environmentId);
  const poolName = usePoolName(environmentId, poolId);
  const [adding, setAdding] = useState<HubAccountKind | "api-key" | "pool" | null>(null);
  const close = () => setAdding(null);
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" />}>
          <PlusIcon aria-hidden />
          Add account
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            {poolName ? <MenuGroupLabel>Add to {poolName}</MenuGroupLabel> : null}
            {(Object.keys(HUB_INSTANCES) as HubAccountKind[]).filter(offers).map((kind) => (
              <MenuItem key={kind} onClick={() => setAdding(kind)}>
                <ProviderInstanceIcon
                  driverKind={HUB_INSTANCES[kind].driver}
                  displayName={HUB_INSTANCES[kind].account}
                  className="size-4"
                  iconClassName="size-4"
                />
                {HUB_INSTANCES[kind].account}
              </MenuItem>
            ))}
            {offers("api-key") ? (
              <MenuItem onClick={() => setAdding("api-key")}>
                <KeyRoundIcon aria-hidden />
                API key
              </MenuItem>
            ) : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setAdding("pool")}>
            <LayersIcon aria-hidden />
            New pool…
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/settings/pools" })}>
            <Settings2Icon aria-hidden />
            Manage pools
          </MenuItem>
        </MenuPopup>
      </Menu>
      {adding === "pool" ? (
        <PoolNameDialog environmentId={environmentId} onClose={close} />
      ) : adding === "api-key" ? (
        <AddPoolApiKeyDialog environmentId={environmentId} poolId={poolId} onClose={close} />
      ) : adding ? (
        <AddHubAccountDialog
          environmentId={environmentId}
          kind={adding}
          poolId={poolId}
          onClose={close}
        />
      ) : null}
    </>
  );
}
