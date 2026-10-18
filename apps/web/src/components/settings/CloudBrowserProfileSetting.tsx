import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSessionState } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { signalboxPersonBrowser } from "~/state/signalboxPersonBrowser";
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
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CloudBrowserProfileSetting({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const status = useEnvironmentQuery(
    signalboxPersonBrowser.profileStatus({ environmentId, input: {} }),
  );
  const session = useEnvironmentSessionState(environmentId);
  const runClearProfile = useAtomCommand(signalboxPersonBrowser.clearProfile, {
    reportFailure: false,
  });
  const canClear = useAtomValue(signalboxPersonBrowser.clearProfile.permissionAtom(environmentId));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const accessChecking = session.isPending || (session.data === null && !session.hasError);
  const clearAvailable =
    status.data?.available === true && canClear && !accessChecking && !session.hasError;
  const rowStatus =
    status.isPending || (status.data === null && status.error === null)
      ? "Checking cloud browser availability."
      : status.error !== null
        ? "Cloud browser availability could not be checked."
        : status.data?.available !== true
          ? "Managed cloud browser is unavailable."
          : session.hasError
            ? "Access could not be checked. Reconnect the cloud environment."
            : accessChecking
              ? "Checking access."
              : !canClear
                ? "This connection cannot clear browser sign-ins."
                : undefined;

  const clearProfile = () => {
    if (!clearAvailable || clearing) return;
    setClearing(true);
    void runClearProfile({ environmentId, input: {} })
      .then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not clear cloud browser sign-ins",
            description: "Clearing could not be confirmed. Try again.",
          });
          return;
        }
        toastManager.add({ type: "success", title: "Cleared cloud browser sign-ins" });
        setConfirmOpen(false);
      })
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Could not clear cloud browser sign-ins",
          description: "Clearing could not be confirmed. Try again.",
        });
      })
      .finally(() => setClearing(false));
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("cloud-browser-profile")}
        description="Signalbox Cloud keeps one private profile for your account. Agents use it for real sites, and its cookies and site storage stay saved between sessions. It is created the first time an agent opens a site."
        status={rowStatus}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!clearAvailable || clearing}
            onClick={() => setConfirmOpen(true)}
          >
            Clear saved sign-ins
          </Button>
        }
      />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!clearing) setConfirmOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear cloud browser sign-ins?</AlertDialogTitle>
            <AlertDialogDescription>
              Open browser sessions close first. Signalbox then removes this profile's cookies and
              site storage. The profile is recreated empty when an agent opens a site again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={clearing}
              render={<Button variant="outline" disabled={clearing} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!clearAvailable || clearing}
              onClick={clearProfile}
            >
              {clearing ? "Clearing…" : "Clear sign-ins"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
