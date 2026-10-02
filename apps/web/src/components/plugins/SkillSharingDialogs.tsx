/**
 * The two sharing confirmations for a skill: publish to everyone in the
 * organization, and stop sharing (subscribers keep a frozen copy). Both the
 * skill page and ticking the org group in the Skills list open these.
 */
import { useState } from "react";

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
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { orgGroup } from "./groupPrimitives";
import { publicationFor } from "./skillSharingFixtures";
import { latestVersion } from "./skillSharingModel";

export function SkillPublishDialog(props: {
  skillName: string | null;
  onOpenChange: (open: boolean) => void;
  onPublished?: () => void;
}) {
  const [autoUpdate, setAutoUpdate] = useState(true);
  const org = orgGroup();
  const publish = () => {
    toastManager.add({
      title: `Published ${props.skillName} v1 to everyone in ${org?.name}`,
      description: autoUpdate
        ? "Teammates get it now, and your next versions sync automatically."
        : "Teammates get it now and choose when to take new versions.",
      timeout: 3000,
    });
    props.onPublished?.();
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.skillName !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share {props.skillName}</DialogTitle>
          <DialogDescription>
            Everyone in {org?.name ?? "your organization"} gets a synced copy. Edit it here and
            publish; their copies follow. No git needed.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} />
            {autoUpdate
              ? "Teammates get new versions automatically"
              : "Teammates choose when to update"}
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={publish}>Publish to {org?.name}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function StopSharingDialog(props: {
  skillId: string | null;
  skillName: string;
  onOpenChange: (open: boolean) => void;
  onStopped?: () => void;
}) {
  const publication = props.skillId ? publicationFor(props.skillId) : undefined;
  const count = publication?.subscribers.length ?? 0;
  const version = publication ? latestVersion(publication) : 1;
  const stop = () => {
    toastManager.add({
      title: `Stopped sharing ${props.skillName}`,
      description: `${count} teammates keep v${version} as a frozen copy.`,
      timeout: 3000,
    });
    props.onStopped?.();
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.skillId !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stop sharing {props.skillName}?</DialogTitle>
          <DialogDescription>
            {count > 0
              ? `The ${count} teammates who have it keep v${version} as a frozen copy and stop getting your updates.`
              : "Nobody has it yet, so nothing else changes."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={stop}>
            Stop sharing
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
