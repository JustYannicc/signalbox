import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  const threads = `${notice.count} thread${notice.count === 1 ? "" : "s"}`;
  // Fork: settle reads as Archive and snooze as Later everywhere.
  const summary =
    notice.action === "Settled"
      ? `Archived ${threads}`
      : notice.action === "Snoozed"
        ? `Moved ${threads} to Later`
        : `${notice.action} ${threads}`;

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {summary},{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? `${shortcut} to undo` : "Undo"}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
