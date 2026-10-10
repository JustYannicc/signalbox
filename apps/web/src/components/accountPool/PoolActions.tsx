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
import { usePoolFeatures } from "../../state/accountPools";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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

type Editing = "rename" | "backing" | "import" | "delete";

/** A pool's own actions: rename, where it keeps logins, import, OpenCode, delete. */
export function PoolActionsMenu({
  environmentId,
  pool,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
}) {
  const can = usePoolFeatures(environmentId);
  const openCode = useOpenCodeOnPool(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const close = () => setEditing(null);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" />}
          aria-label={`Actions for ${pool.name}`}
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => setEditing("rename")}>
            <PencilIcon aria-hidden />
            Rename
          </MenuItem>
          <MenuItem onClick={() => setEditing("backing")}>
            <ServerIcon aria-hidden />
            Where it keeps logins
          </MenuItem>
          {can("import") ? (
            <MenuItem onClick={() => setEditing("import")}>
              <DownloadIcon aria-hidden />
              Import from CLIProxyAPI
            </MenuItem>
          ) : null}
          {can("opencode") ? (
            <MenuItem onClick={() => openCode.set(pool, !openCode.isOn(pool))}>
              <CodeIcon aria-hidden />
              {openCode.isOn(pool) ? "Stop using with OpenCode" : "Use with OpenCode"}
            </MenuItem>
          ) : null}
          {pool.personal ? null : (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => setEditing("delete")}>
                <Trash2Icon aria-hidden />
                Delete
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      {editing === "rename" ? (
        <PoolNameDialog environmentId={environmentId} pool={pool} onClose={close} />
      ) : editing === "backing" ? (
        <PoolBackingDialog environmentId={environmentId} pool={pool} onClose={close} />
      ) : editing === "import" ? (
        <PoolImportDialog environmentId={environmentId} pool={pool} onClose={close} />
      ) : editing === "delete" ? (
        <DeletePoolDialog environmentId={environmentId} pool={pool} onClose={close} />
      ) : null}
    </>
  );
}

/** Starts another pool. */
export function NewPoolButton({
  environmentId,
  variant = "outline",
}: {
  readonly environmentId: EnvironmentId;
  readonly variant?: "outline" | "ghost-muted";
}) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Button size="xs" variant={variant} onClick={() => setCreating(true)}>
        <PlusIcon aria-hidden />
        New pool
      </Button>
      {creating ? (
        <PoolNameDialog environmentId={environmentId} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
