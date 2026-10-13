import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  canManageDrive,
  type DriveItemRole,
  grantableDriveRoles,
  type SignalboxDrive,
  type SignalboxDriveMember,
  type SignalboxDriveRole,
} from "@t3tools/contracts/signalboxDrives";
import { useCallback, useEffect, useState } from "react";

import { environmentDrivesAtom, signalboxDrives } from "../../state/signalboxDrives";
import { useAtomCommand } from "../../state/use-atom-command";
import { DriveMemberRow } from "./DriveMemberRow";
import { driveCommandFailure } from "./driveCommandFailure";
import { DriveInvitePeopleForm } from "./DriveInvitePeopleForm";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface FolderShareTarget {
  readonly myDrive: SignalboxDrive;
  /** Folder path relative to My Drive's root. */
  readonly path: string;
  readonly name: string;
}

export function ShareDriveDialog(props: {
  environmentId: EnvironmentId;
  drive: SignalboxDrive | null;
  folderShare?: FolderShareTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [createdDrive, setCreatedDrive] = useState<SignalboxDrive | null>(null);
  const [members, setMembers] = useState<ReadonlyArray<SignalboxDriveMember>>([]);
  const [membersStatus, setMembersStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const environmentDrives = useAtomValue(environmentDrivesAtom).get(props.environmentId);
  const activeDrive =
    props.drive ??
    (createdDrive === null
      ? null
      : (environmentDrives?.drives.find((drive) => drive.id === createdDrive.id) ?? createdDrive));
  const activeDriveId = activeDrive?.id ?? null;

  const shareAllowed = useAtomValue(signalboxDrives.share.permissionAtom(props.environmentId));
  const unshareAllowed = useAtomValue(signalboxDrives.unshare.permissionAtom(props.environmentId));
  const shareFolderAllowed = useAtomValue(
    signalboxDrives.shareFolder.permissionAtom(props.environmentId),
  );
  const membersCommand = useAtomCommand(signalboxDrives.members, { reportFailure: false });
  const shareCommand = useAtomCommand(signalboxDrives.share, { reportFailure: false });
  const unshareCommand = useAtomCommand(signalboxDrives.unshare, { reportFailure: false });
  const shareFolderCommand = useAtomCommand(signalboxDrives.shareFolder, { reportFailure: false });

  const fetchMembers = useCallback(
    (driveId: SignalboxDrive["id"]) =>
      membersCommand({ environmentId: props.environmentId, input: { driveId } }),
    [membersCommand, props.environmentId],
  );
  const showMembers = useCallback((result: Awaited<ReturnType<typeof fetchMembers>>) => {
    if (result._tag === "Failure") {
      const message = driveCommandFailure(result);
      if (message !== null) setError(message);
      setMembersStatus("error");
      return;
    }
    setMembers(result.value.members);
    setMembersStatus("loaded");
  }, []);
  const loadMembers = async (driveId: SignalboxDrive["id"]) =>
    showMembers(await fetchMembers(driveId));

  useEffect(() => {
    if (!props.open || activeDriveId === null) return;
    let current = true;
    // A late answer for a drive the dialog no longer shows is dropped.
    void fetchMembers(activeDriveId).then((result) => {
      if (current) showMembers(result);
    });
    return () => {
      current = false;
    };
  }, [activeDriveId, fetchMembers, showMembers, props.open]);

  const roles = grantableDriveRoles(activeDrive?.kind ?? (props.folderShare ? "folder" : "my"));
  const manager =
    activeDrive !== null
      ? canManageDrive(activeDrive.role)
      : props.folderShare !== undefined && canManageDrive(props.folderShare.myDrive.role);
  const canAddPeople =
    manager && (activeDrive !== null ? shareAllowed : shareFolderAllowed) && roles.length > 0;
  const canChangeRole = manager && shareAllowed;
  const canRemove = manager && unshareAllowed;
  const folderName = props.folderShare?.name;
  const title = folderName ? `Share ${folderName}` : `Share ${activeDrive?.name ?? "drive"}`;

  const addPerson = async (email: string, role: SignalboxDriveRole) => {
    if (!email || adding || !canAddPeople) return false;
    setAdding(true);
    setError(null);
    try {
      if (activeDrive === null && props.folderShare !== undefined) {
        const result = await shareFolderCommand({
          environmentId: props.environmentId,
          input: {
            driveId: props.folderShare.myDrive.id,
            path: props.folderShare.path,
            email,
            role: role as DriveItemRole,
          },
        });
        if (result._tag === "Failure") {
          const message = driveCommandFailure(result);
          if (message !== null) setError(message);
          return false;
        }
        setCreatedDrive(result.value);
        setMembersStatus("loading");
        return true;
      }
      if (activeDrive === null) return false;
      const result = await shareCommand({
        environmentId: props.environmentId,
        input: { driveId: activeDrive.id, email, role },
      });
      if (result._tag === "Failure") {
        const message = driveCommandFailure(result);
        if (message !== null) setError(message);
        return false;
      }
      await loadMembers(activeDrive.id);
      return true;
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (member: SignalboxDriveMember, role: SignalboxDriveRole) => {
    if (activeDrive === null || !canChangeRole) return;
    setPendingUserId(member.userId);
    setError(null);
    const result = await shareCommand({
      environmentId: props.environmentId,
      input: { driveId: activeDrive.id, email: member.email, role },
    });
    if (result._tag === "Failure") {
      const message = driveCommandFailure(result);
      if (message !== null) setError(message);
    } else {
      await loadMembers(activeDrive.id);
    }
    setPendingUserId(null);
  };

  const removeMember = async (member: SignalboxDriveMember) => {
    if (activeDrive === null || !canRemove) return;
    setPendingUserId(member.userId);
    setError(null);
    const result = await unshareCommand({
      environmentId: props.environmentId,
      input: { driveId: activeDrive.id, userId: member.userId },
    });
    if (result._tag === "Failure") {
      const message = driveCommandFailure(result);
      if (message !== null) setError(message);
    } else {
      await loadMembers(activeDrive.id);
    }
    setPendingUserId(null);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open || (!adding && pendingUserId === null)) props.onOpenChange(open);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Choose who can open these files and what they can do.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {activeDrive === null ? (
            <p className="text-sm text-muted-foreground">Only you have access to this folder.</p>
          ) : (
            <section aria-label="People with access">
              <h3 className="mb-1 text-sm font-medium">People with access</h3>
              {membersStatus === "loading" ? (
                <p role="status" className="py-3 text-sm text-muted-foreground">
                  Loading people…
                </p>
              ) : membersStatus === "error" ? (
                <p role="status" className="py-3 text-sm text-muted-foreground">
                  People with access couldn't be loaded.
                </p>
              ) : members.length > 0 ? (
                <ul className="divide-y divide-border/60">
                  {members.map((member) => (
                    <DriveMemberRow
                      key={member.userId}
                      member={member}
                      roles={roles}
                      canChangeRole={canChangeRole}
                      canRemove={canRemove}
                      pending={pendingUserId !== null || adding}
                      onChangeRole={(person, role) => void changeRole(person, role)}
                      onRemove={(person) => void removeMember(person)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">No one has access yet.</p>
              )}
            </section>
          )}
          {canAddPeople ? (
            <DriveInvitePeopleForm
              roles={roles}
              disabled={adding || pendingUserId !== null}
              submitting={adding}
              onInvite={addPerson}
            />
          ) : null}
          {error !== null ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="secondary"
            onClick={() => props.onOpenChange(false)}
            disabled={adding || pendingUserId !== null}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
