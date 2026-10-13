import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountPool } from "@t3tools/contracts/accountHub";
import { useState } from "react";

import { useEnvironmentHttpBaseUrl } from "../../state/environments";
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
import { toastManager } from "../ui/toast";
import { failureText } from "./PoolDialogs";

/**
 * Moves a pool of this server into Signalbox Cloud. The cloud makes the pool
 * ready and hands back a link; this server sends its accounts over it, drops
 * its own copies, and runs the pool through the cloud from then on. A move
 * that fails leaves the pool here and removes the cloud pool it started.
 */
export function MoveToCloudDialog({
  environmentId,
  cloudEnvironmentId,
  pool,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cloudEnvironmentId: EnvironmentId;
  readonly pool: AccountPool;
  readonly onClose: () => void;
}) {
  const cloudUrl = useEnvironmentHttpBaseUrl(cloudEnvironmentId);
  const receive = useAtomCommand(serverEnvironment.receiveAccountPool, { reportFailure: false });
  const move = useAtomCommand(serverEnvironment.moveAccountPoolToCloud, { reportFailure: false });
  const removeCloudPool = useAtomCommand(serverEnvironment.deleteAccountPool, {
    reportFailure: false,
  });
  const refreshCloud = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (cloudUrl === null) return;
    setPending(true);
    setError(null);
    const received = await receive({
      environmentId: cloudEnvironmentId,
      input: { name: pool.name, personal: pool.personal },
    });
    if (received._tag !== "Success") {
      setPending(false);
      setError(failureText(received, "Signalbox Cloud could not take the pool. Try again."));
      return;
    }
    const moved = await move({
      environmentId,
      input: { poolId: pool.id, cloudUrl, token: received.value.token },
    });
    if (moved._tag !== "Success") {
      // The accounts are still here, so the pool the cloud started for them goes again.
      const leftover =
        !received.value.personal &&
        (
          await removeCloudPool({
            environmentId: cloudEnvironmentId,
            input: { poolId: received.value.poolId },
          })
        )._tag !== "Success";
      setPending(false);
      const reason = failureText(moved, "Could not move the pool. Try again.");
      setError(
        leftover
          ? `${reason} An empty ${pool.name} pool is left in Signalbox Cloud; delete it there.`
          : reason,
      );
      return;
    }
    await refreshCloud({ environmentId: cloudEnvironmentId, input: {} });
    const { moved: count, warnings } = moved.value;
    toastManager.add({
      type: warnings.length > 0 ? "warning" : "success",
      title: `${pool.name} is in Signalbox Cloud`,
      description:
        warnings.length > 0
          ? warnings.join(" ")
          : `${count} ${count === 1 ? "account" : "accounts"} moved.`,
    });
    onClose();
  };

  return (
    <AlertDialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {pool.name} to Signalbox Cloud?</AlertDialogTitle>
          <AlertDialogDescription>
            {pool.personal
              ? "Its accounts join your Personal pool in Signalbox Cloud and leave this server."
              : "It becomes a pool in Signalbox Cloud with the same name and accounts, and its accounts leave this server."}{" "}
            Threads here keep running on it.
          </AlertDialogDescription>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button disabled={pending || cloudUrl === null} onClick={() => void run()}>
            {pending ? "Moving…" : "Move"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
