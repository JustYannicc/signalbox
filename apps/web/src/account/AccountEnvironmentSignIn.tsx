import { type AccountReturn, fetchAccountSessionState } from "@t3tools/client-runtime/account";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { connectPairing as connectPairingAtom } from "../connection/onboarding";
import { useAtomCommand } from "../state/use-atom-command";
import {
  AccountFlowError,
  cancelNativeSignIn,
  completeEnvironmentSignIn,
  isDesktop,
  readPendingEnvironmentSignIn,
  startNativeSignIn,
} from "./accountSession";
import { reloadAt } from "./accountPlatform";

/**
 * Desktop's "Add environment" alternative to a pairing code: sign in to an
 * environment that offers accounts, such as Signalbox Cloud. Sign-in finishes
 * in the system browser and comes back to `/sign-in`, which hands the return
 * to `useFinishEnvironmentSignIn`. Web has no app link to come back to; there,
 * open the environment's own address instead.
 */

type Status =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting" }
  | { readonly _tag: "waiting"; readonly origin: string }
  | { readonly _tag: "unsupported" };

/** The environment's origin from what was typed in Host, `https` unless a scheme is given. */
function environmentOrigin(host: string): string | null {
  const trimmed = host.trim().replace(/^\/+/u, "");
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Finishes an environment sign-in when its return lands on `/sign-in`: pairs
 * the environment with the redeemed credential and opens the app, or reports
 * the failure in Connections, where the attempt started.
 */
export function useFinishEnvironmentSignIn() {
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const navigate = useNavigate();
  return useCallback(
    (accountReturn: AccountReturn) => {
      const finish = async () => {
        if (accountReturn._tag === "error") throw new AccountFlowError(accountReturn.error);
        const { origin, credential } = await completeEnvironmentSignIn(accountReturn.handoff);
        const added = await connectPairing({ host: origin, pairingCode: credential });
        if (added._tag === "Failure") throw new AccountFlowError("failed");
        reloadAt("/");
      };
      finish().catch((error: unknown) => {
        cancelNativeSignIn();
        const cancelled = error instanceof AccountFlowError && error.code === "cancelled";
        toastManager.add({
          type: cancelled ? "info" : "error",
          title: cancelled ? "Sign-in cancelled" : "Could not add the environment",
          description: cancelled
            ? "The environment was not added."
            : "Signing in didn't finish. Try again.",
        });
        void navigate({ to: "/settings/connections", replace: true });
      });
    },
    [connectPairing, navigate],
  );
}

export function AccountEnvironmentSignIn({
  host,
  disabled,
}: {
  readonly host: string;
  readonly disabled: boolean;
}) {
  // A sign-in started earlier is still waiting even if this dialog was closed.
  const [status, setStatus] = useState<Status>(() => {
    const pending = isDesktop() ? readPendingEnvironmentSignIn() : null;
    return pending ? { _tag: "waiting", origin: pending } : { _tag: "idle" };
  });
  if (!isDesktop()) return null;
  const origin = environmentOrigin(host);

  const start = async (target: string) => {
    setStatus({ _tag: "starting" });
    try {
      const session = await fetchAccountSessionState(target, { credentials: "omit" });
      if (!session.enabled) {
        setStatus({ _tag: "unsupported" });
        return;
      }
      await startNativeSignIn({ screenHint: "sign-in", environmentOrigin: target });
      setStatus({ _tag: "waiting", origin: target });
    } catch {
      // Servers without accounts have no account routes, so this also covers them.
      setStatus({ _tag: "unsupported" });
    }
  };

  if (status._tag === "waiting") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Finish signing in to {new URL(status.origin).host} in your browser. It's added when you're
          done.
        </p>
        <Button size="xs" variant="outline" onClick={() => void start(status.origin)}>
          Open browser again
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            cancelNativeSignIn();
            setStatus({ _tag: "idle" });
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || origin === null || status._tag === "starting"}
        aria-busy={status._tag === "starting"}
        onClick={() => origin && void start(origin)}
      >
        {status._tag === "starting" ? <Spinner aria-hidden /> : null}
        Sign in with an account
      </Button>
      <span className="text-2xs text-muted-foreground">
        {status._tag === "unsupported"
          ? "This server doesn't offer accounts. Use its pairing code."
          : "For servers with accounts, like Signalbox Cloud. No pairing code needed."}
      </span>
    </div>
  );
}
