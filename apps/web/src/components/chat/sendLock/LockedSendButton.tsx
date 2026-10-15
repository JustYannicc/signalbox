/**
 * The send button while a draft's sending is locked. It keeps Send's place,
 * shape and hue, muted, with a padlock, and a click explains the lock and
 * offers Unlock instead of silently doing nothing. Locking itself lives in the
 * `/lock` command, away from Send's hit area, so a click aimed at Send never
 * locks.
 */
import { LockIcon } from "lucide-react";

import { Button } from "../../ui/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../../ui/popover";
import { useComposerMenuProps } from "../composerEventScope";
import { SEND_LOCKED_REASON } from "./composerSendLockStore";

export function LockedSendButton(props: { onUnlock: () => void }) {
  const menuProps = useComposerMenuProps();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={SEND_LOCKED_REASON}
            data-chat-composer-send-locked="true"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action/12 text-message-action outline-none ring-1 ring-message-action/30 ring-inset transition-colors duration-150 hover:bg-message-action/20 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-message-action/20 sm:size-8 [&_svg]:pointer-events-none"
          />
        }
      >
        <LockIcon className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" {...menuProps}>
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <PopoverTitle>Sending is locked</PopoverTitle>
            <p className="text-muted-foreground text-xs">
              This draft won't send, and Enter adds a new line. Lock it again any time with /lock.
            </p>
          </div>
          <div className="flex justify-end">
            <PopoverClose render={<Button size="sm" onClick={props.onUnlock} />}>
              Unlock sending
            </PopoverClose>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
