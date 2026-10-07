import { poolIdForSourceId } from "@t3tools/contracts/accountHub";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { LogInIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { AddHubAccountDialog } from "./AddHubAccountDialog";
import { hubAccountKindForDriver } from "./hubInstances";

/** "Sign in again" on a pool account whose login died. */
export function SignInAgainButton({ account }: { readonly account: LimitAccount }) {
  const [open, setOpen] = useState(false);
  const hub = account.hubAccount;
  // Only a pool's own accounts can be signed in again here; paused ones are left alone.
  const poolId = hub ? poolIdForSourceId(hub.sourceId) : null;
  const kind = hub?.signedOut && !hub.disabled ? hubAccountKindForDriver(account.driver) : null;
  if (!hub || !kind || !poolId) return null;
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <LogInIcon aria-hidden />
        Sign in again
      </Button>
      {open ? (
        <AddHubAccountDialog
          environmentId={hub.environmentId}
          kind={kind}
          poolId={poolId}
          reauth={{ accountId: hub.accountId, email: account.email }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
