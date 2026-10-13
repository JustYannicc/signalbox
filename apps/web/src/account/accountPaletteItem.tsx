import { LogOutIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { signOutWithFeedback } from "./AccountSettingsSection";
import { readAccountSession } from "./accountSession";

/** Command palette "Sign out", present only while signed in to an account. */
export function accountSignOutPaletteItem(): CommandPaletteActionItem | null {
  const account = readAccountSession()?.account;
  if (!account) return null;
  return {
    kind: "action",
    value: "action:account-sign-out",
    searchTerms: ["sign out", "log out", "logout", "account", account.email],
    title: "Sign out",
    description: account.email,
    icon: <LogOutIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await signOutWithFeedback();
    },
  };
}
