/**
 * ChatComposer's slash menu with `/lock` and `/unlock` handled before the
 * composer's own select, so a click on either never reaches it.
 */
import type { ComponentProps } from "react";

import { type ComposerCommandItem, ComposerCommandMenu } from "../ComposerCommandMenu";

export function SendLockComposerCommandMenu({
  onSendLockCommand,
  onSelect,
  ...props
}: ComponentProps<typeof ComposerCommandMenu> & {
  /** Handles the item when it is `/lock` or `/unlock`; false hands it to `onSelect`. */
  onSendLockCommand: (item: ComposerCommandItem) => boolean;
}) {
  return (
    <ComposerCommandMenu
      {...props}
      onSelect={(item) => {
        if (!onSendLockCommand(item)) onSelect(item);
      }}
    />
  );
}
