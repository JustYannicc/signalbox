import type { AccountProfile } from "@t3tools/contracts/account";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { readAccountSession, signOutAccount } from "./accountSession";

function accountDisplayName(account: AccountProfile): string {
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ").trim();
  return name || account.email;
}

/** Runs sign-out; success reloads into `/sign-in`, failure toasts and resolves false. */
export async function signOutWithFeedback(): Promise<boolean> {
  return signOutAccount().then(
    () => true,
    (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Couldn't sign out",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return false;
    },
  );
}

/** Settings → General: who this Signalbox is signed in as, and the way out. */
export function AccountSettingsSection() {
  const account = readAccountSession()?.account ?? null;
  const [signingOut, setSigningOut] = useState(false);
  if (!account) return null;

  const name = accountDisplayName(account);
  return (
    <SettingsSection id="account" title="Account">
      <SettingsRow
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar account={account} name={name} />
            <span className="truncate">{name}</span>
          </span>
        }
        {...(name === account.email ? {} : { description: account.email })}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOutWithFeedback().then((signedOut) => {
                if (!signedOut) setSigningOut(false);
              });
            }}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

function AccountAvatar({ account, name }: { account: AccountProfile; name: string }) {
  const [failed, setFailed] = useState(false);
  if (account.avatarUrl && !failed) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="size-6 shrink-0 rounded-full bg-muted object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
