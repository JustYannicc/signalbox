import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { driveOfProject } from "@t3tools/client-runtime/state/signalboxDrives";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SignalboxDrive } from "@t3tools/contracts/signalboxDrives";
import { Share2Icon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { environmentDrivesAtom } from "../../state/signalboxDrives";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { ShareDriveDialog } from "./ShareDriveDialog";

/**
 * The drive whose share dialog is open. The menu that opens it unmounts as it
 * closes, so the dialog lives in `DriveShareDialogHost` instead.
 */
const shareTargetAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly drive: SignalboxDrive;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("web-drive-share-target"));

/** "Share…" in a shared or shared-folder drive's project menu. */
export function DriveProjectShareMenuItem(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const drives = useAtomValue(environmentDrivesAtom).get(props.environmentId);
  const setTarget = useAtomSet(shareTargetAtom);
  const drive = driveOfProject(drives ?? null, props.projectId);
  if (drive === undefined || drive.kind === "my") return null;

  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={() => setTarget({ environmentId: props.environmentId, drive })}>
        <Share2Icon />
        Share…
      </MenuItem>
    </>
  );
}

/** Renders the share dialog `DriveProjectShareMenuItem` opened, for one environment's sidebar. */
export function DriveShareDialogHost(props: { environmentId: EnvironmentId }) {
  const target = useAtomValue(shareTargetAtom);
  const setTarget = useAtomSet(shareTargetAtom);
  if (target === null || target.environmentId !== props.environmentId) return null;
  return (
    <ShareDriveDialog
      environmentId={target.environmentId}
      drive={target.drive}
      open
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    />
  );
}
