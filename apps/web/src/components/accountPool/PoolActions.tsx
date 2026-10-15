import type { EnvironmentId } from "@t3tools/contracts";
import { poolInstanceId, type AccountPool, type PoolRouting } from "@t3tools/contracts/accountHub";
import {
  CloudUploadIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  ShuffleIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { usePoolFeatures, useSignalboxCloudEnvironmentId } from "../../state/accountPools";
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
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { MoveToCloudDialog } from "./MoveToCloudDialog";
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

const STRATEGIES: ReadonlyArray<{
  readonly value: PoolRouting["strategy"];
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "round-robin", label: "Round robin", hint: "Each account in turn" },
  { value: "fill-first", label: "Fill first", hint: "One account until it runs out" },
];

/**
 * How a pool spreads turns across its accounts, for its admins: each choice
 * applies to the pool at once (`accountPool.setRouting`).
 */
function LoadBalancingSubmenu({
  environmentId,
  pool,
  routing,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
  readonly routing: PoolRouting;
}) {
  const setRouting = useAtomCommand(
    serverEnvironment.setAccountPoolRouting,
    "Change load balancing",
  );
  // Only what changed, so a second click before the first lands doesn't undo it.
  const change = (next: Partial<PoolRouting>) =>
    void setRouting({ environmentId, input: { poolId: pool.id, routing: next } });
  return (
    <MenuSub>
      <MenuSubTrigger>
        <ShuffleIcon aria-hidden />
        Load balancing
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuGroup>
          <MenuGroupLabel>Spread turns</MenuGroupLabel>
          <MenuRadioGroup
            value={routing.strategy}
            onValueChange={(value) => change({ strategy: value as PoolRouting["strategy"] })}
          >
            {STRATEGIES.map((strategy) => (
              <MenuRadioItem key={strategy.value} value={strategy.value}>
                {strategy.label}
                <span className="ms-auto ps-4 text-muted-foreground">{strategy.hint}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={routing.sessionAffinity}
          onCheckedChange={(checked) => change({ sessionAffinity: checked })}
        >
          Keep each thread on one account
        </MenuCheckboxItem>
        <MenuGroup>
          <MenuGroupLabel>Move a thread when its account fails</MenuGroupLabel>
          <MenuRadioGroup
            value={routing.moveOn}
            onValueChange={(value) => change({ moveOn: value as PoolRouting["moveOn"] })}
          >
            <MenuRadioItem value="quota" disabled={!routing.sessionAffinity}>
              On quota or sign-in errors
            </MenuRadioItem>
            <MenuRadioItem value="any" disabled={!routing.sessionAffinity}>
              On any error
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
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
              : pool.backing.mode === "cloud"
                ? "Its models leave the picker here and threads here stop running on it. The pool and its accounts stay in Signalbox Cloud."
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

type Editing = "rename" | "backing" | "import" | "move" | "delete";

/**
 * A pool's own actions: rename, where it keeps logins, import, load
 * balancing, OpenCode, move to the cloud, delete.
 */
export function PoolActionsMenu({
  environmentId,
  pool,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
}) {
  const can = usePoolFeatures(environmentId);
  const openCode = useOpenCodeOnPool(environmentId);
  const cloudEnvironmentId = useSignalboxCloudEnvironmentId();
  // A pool already in the cloud is managed there.
  const inCloud = pool.backing.mode === "cloud";
  const canMove = !inCloud && cloudEnvironmentId !== null && cloudEnvironmentId !== environmentId;
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
          {inCloud ? null : (
            <MenuItem onClick={() => setEditing("backing")}>
              <ServerIcon aria-hidden />
              Where it keeps logins
            </MenuItem>
          )}
          {can("import") && !inCloud ? (
            <MenuItem onClick={() => setEditing("import")}>
              <DownloadIcon aria-hidden />
              Import from CLIProxyAPI
            </MenuItem>
          ) : null}
          {pool.routing !== undefined ? (
            <LoadBalancingSubmenu
              environmentId={environmentId}
              pool={pool}
              routing={pool.routing}
            />
          ) : null}
          {can("opencode") ? (
            <MenuItem onClick={() => openCode.set(pool, !openCode.isOn(pool))}>
              <CodeIcon aria-hidden />
              {openCode.isOn(pool) ? "Stop using with OpenCode" : "Use with OpenCode"}
            </MenuItem>
          ) : null}
          {canMove ? (
            <MenuItem onClick={() => setEditing("move")}>
              <CloudUploadIcon aria-hidden />
              Move to Signalbox Cloud
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
      ) : editing === "move" && cloudEnvironmentId !== null ? (
        <MoveToCloudDialog
          environmentId={environmentId}
          cloudEnvironmentId={cloudEnvironmentId}
          pool={pool}
          onClose={close}
        />
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
