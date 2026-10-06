import type { EnvironmentId } from "@t3tools/contracts";
import { poolInstanceId, type AccountPool } from "@t3tools/contracts/accountHub";
import {
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAccountPools } from "../../state/accountPools";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { MoveNativeLogins } from "./MoveNativeLogins";
import { failureText, PoolBackingDialog, PoolImportDialog, PoolNameDialog } from "./PoolDialogs";

/**
 * Runs OpenCode on a pool, or stops. OpenCode then offers every model the
 * pool serves, through the pool's own hub.
 */
function useOpenCodeOnPool(environmentId: EnvironmentId) {
  const instances = useEnvironmentSettings(environmentId, (settings) => settings.providerInstances);
  const setOpenCode = useAtomCommand(serverEnvironment.setAccountPoolOpenCode, "Change OpenCode");
  return {
    isOn: (pool: AccountPool) => poolInstanceId("opencode", pool.id) in instances,
    set: (pool: AccountPool, enabled: boolean) =>
      void setOpenCode({ environmentId, input: { poolId: pool.id, enabled } }),
  };
}

type Editing =
  | { readonly kind: "create" }
  | { readonly kind: "rename" | "backing" | "import" | "delete"; readonly pool: AccountPool };

function backingText(pool: AccountPool) {
  return pool.backing.mode === "managed"
    ? "Signalbox keeps its logins"
    : `Logins in your CLIProxyAPI at ${new URL(pool.backing.url).host}`;
}

function DeletePoolDialog({
  environmentId,
  pool,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
  readonly onClose: () => void;
}) {
  const remove = useAtomCommand(serverEnvironment.deleteAccountPool, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    const result = await remove({ environmentId, input: { poolId: pool.id } });
    setPending(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Could not delete ${pool.name}`,
        description: failureText(result, "Try again."),
      });
      return;
    }
    onClose();
  };
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pool.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {pool.backing.mode === "managed"
              ? "Its accounts are removed from Signalbox, its models leave the picker, and threads on it stop working."
              : "Its models leave the picker and threads on it stop working. The accounts stay in your CLIProxyAPI."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Settings → Pools: every pool of the environment, and where each keeps its logins. */
export function PoolsSettings() {
  // Pools belong to one environment; the settings scope picks which.
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return environmentId ? <EnvironmentPools environmentId={environmentId} /> : null;
}

function EnvironmentPools({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pools = useAccountPools(environmentId);
  const openCode = useOpenCodeOnPool(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const close = () => setEditing(null);
  return (
    <SettingsPageContainer>
      <MoveNativeLogins environmentId={environmentId} framed />
      <SettingsSection
        id="pools"
        title="Pools"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setEditing({ kind: "create" })}>
            <PlusIcon aria-hidden />
            New pool
          </Button>
        }
      >
        {pools.map((pool) => (
          <SettingsRow
            key={pool.id}
            title={pool.name}
            description={backingText(pool)}
            control={
              <Menu>
                <MenuTrigger
                  render={<Button variant="ghost-muted" size="icon-xs" />}
                  aria-label={`Actions for ${pool.name}`}
                >
                  <EllipsisIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => setEditing({ kind: "rename", pool })}>
                    <PencilIcon aria-hidden />
                    Rename
                  </MenuItem>
                  <MenuItem onClick={() => setEditing({ kind: "backing", pool })}>
                    <ServerIcon aria-hidden />
                    Where it keeps logins
                  </MenuItem>
                  <MenuItem onClick={() => setEditing({ kind: "import", pool })}>
                    <DownloadIcon aria-hidden />
                    Import from CLIProxyAPI
                  </MenuItem>
                  <MenuItem onClick={() => openCode.set(pool, !openCode.isOn(pool))}>
                    <CodeIcon aria-hidden />
                    {openCode.isOn(pool) ? "Stop using with OpenCode" : "Use with OpenCode"}
                  </MenuItem>
                  {pool.personal ? null : (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() => setEditing({ kind: "delete", pool })}
                      >
                        <Trash2Icon aria-hidden />
                        Delete
                      </MenuItem>
                    </>
                  )}
                </MenuPopup>
              </Menu>
            }
          />
        ))}
      </SettingsSection>
      {editing?.kind === "create" ? (
        <PoolNameDialog environmentId={environmentId} onClose={close} />
      ) : editing?.kind === "rename" ? (
        <PoolNameDialog environmentId={environmentId} pool={editing.pool} onClose={close} />
      ) : editing?.kind === "backing" ? (
        <PoolBackingDialog environmentId={environmentId} pool={editing.pool} onClose={close} />
      ) : editing?.kind === "import" ? (
        <PoolImportDialog environmentId={environmentId} pool={editing.pool} onClose={close} />
      ) : editing?.kind === "delete" ? (
        <DeletePoolDialog environmentId={environmentId} pool={editing.pool} onClose={close} />
      ) : null}
    </SettingsPageContainer>
  );
}
