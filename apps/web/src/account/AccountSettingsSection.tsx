import { fetchAccountSessionState, signOutAccountSession } from "@t3tools/client-runtime/account";
import { ACCOUNT_SIGN_IN_ROUTE, type AccountProfile } from "@t3tools/contracts/account";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { useEnvironments } from "../state/environments";
import { usePreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { reloadAt } from "./accountPlatform";
import { readAccountSession, signOutAccount } from "./accountSession";
import { cloudDefaultOrigin } from "./cloudDefault";

function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

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
  // The desktop gateway is signed in to Signalbox Cloud, not to a primary server.
  if (cloudDefaultOrigin() !== null) return <CloudAccountSection />;
  return <PrimaryAccountSection />;
}

function PrimaryAccountSection() {
  const account = readAccountSession()?.account ?? null;
  const [signingOut, setSigningOut] = useState(false);
  if (!account) return null;
  return (
    <AccountRow
      account={account}
      signingOut={signingOut}
      onSignOut={() => {
        setSigningOut(true);
        void signOutWithFeedback().then((signedOut) => {
          if (!signedOut) setSigningOut(false);
        });
      }}
    />
  );
}

/**
 * The desktop gateway's account: the session it holds on Signalbox Cloud, its one
 * environment. Signing out revokes that session when the cloud answers, forgets the
 * environment either way, and starts over on sign-in.
 */
function CloudAccountSection() {
  const { environments } = useEnvironments();
  // Matched by origin: anything paired before the cloud became the only environment stays put.
  const cloud =
    environments.find((environment) => originOf(environment.displayUrl) === cloudDefaultOrigin()) ??
    (environments.length === 1 ? environments[0]! : null);
  const prepared = Option.getOrNull(usePreparedConnection(cloud?.environmentId ?? null));
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const httpBaseUrl = prepared?.httpBaseUrl ?? null;
  const token =
    prepared?.httpAuthorization?._tag === "Bearer" ? prepared.httpAuthorization.token : null;

  useEffect(() => {
    if (httpBaseUrl === null || token === null) return;
    let cancelled = false;
    fetchAccountSessionState(httpBaseUrl, {
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    }).then(
      (session) => {
        if (!cancelled) setAccount(session.account);
      },
      () => {
        // Keep the last answer; an unreachable cloud doesn't change who signed in.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [httpBaseUrl, token]);

  // Offered even when the cloud can't say who is signed in (offline, expired): it is the only
  // way to leave it.
  if (cloud === null) return null;
  return (
    <AccountRow
      account={account}
      signingOut={signingOut}
      onSignOut={() => {
        setSigningOut(true);
        const revoke =
          httpBaseUrl !== null && token !== null
            ? signOutAccountSession(httpBaseUrl, {
                credentials: "omit",
                headers: { authorization: `Bearer ${token}` },
                timeoutMs: 5_000,
              }).catch(() => undefined)
            : Promise.resolve(undefined);
        void revoke
          .then(() => removeEnvironment(cloud.environmentId))
          .then((removed) => {
            if (removed._tag === "Failure") {
              setSigningOut(false);
              toastManager.add({
                type: "error",
                title: "Couldn't sign out",
                description: "Try again.",
              });
              return;
            }
            reloadAt(ACCOUNT_SIGN_IN_ROUTE);
          });
      }}
    />
  );
}

function AccountRow({
  account,
  signingOut,
  onSignOut,
}: {
  /** Null while the cloud hasn't said who is signed in. */
  readonly account: AccountProfile | null;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}) {
  const name = account ? accountDisplayName(account) : "Signalbox";
  return (
    <SettingsSection id="account" title="Account">
      <SettingsRow
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            {account ? <AccountAvatar account={account} name={name} /> : null}
            <span className="truncate">{name}</span>
          </span>
        }
        {...(account === null || name === account.email ? {} : { description: account.email })}
        control={
          <Button size="sm" variant="outline" disabled={signingOut} onClick={onSignOut}>
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
