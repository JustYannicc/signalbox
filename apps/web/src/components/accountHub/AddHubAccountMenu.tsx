import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { AddHubAccountDialog } from "./AddHubAccountDialog";
import { HUB_INSTANCES, type HubAccountKind } from "./hubInstances";

/**
 * "Add account" on Limits. Accounts go to the hub on the environment being
 * looked at; with several selected, the primary one.
 */
export function AddHubAccountMenu({
  environmentIds,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const primary = usePrimaryEnvironmentId();
  const [adding, setAdding] = useState<HubAccountKind | null>(null);
  const environmentId =
    environmentIds.length === 1
      ? environmentIds[0]
      : primary && environmentIds.includes(primary)
        ? primary
        : environmentIds[0];
  if (!environmentId) return null;
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" />}>
          <PlusIcon aria-hidden />
          Add account
        </MenuTrigger>
        <MenuPopup align="end">
          {(Object.keys(HUB_INSTANCES) as HubAccountKind[]).map((kind) => (
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
        </MenuPopup>
      </Menu>
      {adding ? (
        <AddHubAccountDialog
          environmentId={environmentId}
          kind={adding}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  );
}
