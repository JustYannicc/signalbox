import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { HardDriveIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { signalboxDrives } from "../../state/signalboxDrives";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { driveCommandFailure } from "./driveCommandFailure";

export function NewSharedDriveButton(props: {
  environmentId: EnvironmentId;
  contextId: SignalboxContextId;
  contextName: string;
}) {
  const canCreate = useAtomValue(signalboxDrives.create.permissionAtom(props.environmentId));
  const createDrive = useAtomCommand(signalboxDrives.create, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCreate) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || pending) return;
    setPending(true);
    setError(null);
    const result = await createDrive({
      environmentId: props.environmentId,
      input: { contextId: props.contextId, name: trimmedName },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(driveCommandFailure(result));
      return;
    }
    setName("");
    setOpen(false);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`New shared drive in ${props.contextName}`}
              onClick={() => setOpen(true)}
            />
          }
        >
          <HardDriveIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">New shared drive</TooltipPopup>
      </Tooltip>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!pending) setOpen(nextOpen);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New shared drive</DialogTitle>
            <DialogDescription>Create a shared drive for {props.contextName}.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)}>
            <DialogPanel>
              <label className="block space-y-1.5 text-sm font-medium">
                Drive name
                <Input
                  autoFocus
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={pending}
                  required
                />
              </label>
              {error !== null ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || name.trim().length === 0}>
                {pending ? "Creating…" : "Create drive"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
