import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { LogInIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { AddHubAccountDialog } from "./AddHubAccountDialog";
import { hubAccountKindForDriver } from "./hubInstances";

/** Where a hub account whose login died can be signed in again, if anywhere. */
function signInAgainTarget(account: LimitAccount) {
  const hub = account.hubAccount;
  // Only the account hub's accounts can be signed in again here; paused ones are left alone.
  const kind =
    hub?.signedOut && !hub.disabled && hub.sourceId === ACCOUNT_HUB_SOURCE_ID
      ? hubAccountKindForDriver(account.driver)
      : null;
  return hub && kind
    ? {
        environmentId: hub.environmentId,
        kind,
        reauth: { accountId: hub.accountId, email: account.email },
      }
    : null;
}

/** "Sign in again" on a hub account whose login died. */
export function SignInAgainButton({ account }: { readonly account: LimitAccount }) {
  const [open, setOpen] = useState(false);
  const target = signInAgainTarget(account);
  if (!target) return null;
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <LogInIcon aria-hidden />
        Sign in again
      </Button>
      {open ? <AddHubAccountDialog {...target} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
