/** The command palette's quick capture entry, listed first among its actions. */
import { InboxIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { openQuickCapture } from "./quickCaptureStore";

export const QUICK_CAPTURE_PALETTE_ITEM: CommandPaletteActionItem = {
  kind: "action",
  value: "action:quick-capture",
  searchTerms: ["quick capture", "capture", "new", "jot", "draft", "write down", "inbox"],
  title: "Quick capture",
  icon: <InboxIcon className={ITEM_ICON_CLASS} />,
  shortcutCommand: "capture.open",
  run: async () => openQuickCapture(),
};
