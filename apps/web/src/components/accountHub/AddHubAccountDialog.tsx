import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { hubReauthMethodId } from "@t3tools/contracts/accountHub";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { HUB_INSTANCES, type HubAccountKind } from "./hubInstances";
import { HubSignIn } from "./HubSignIn";

/**
 * Adds one account to the account hub, or signs a dead one in again
 * (`reauth`). The first account also creates the hub's provider instance;
 * every later one joins it.
 */
export function AddHubAccountDialog({
  environmentId,
  kind,
  reauth,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: HubAccountKind;
  /** The hub account whose login died; the dialog signs that account in again. */
  readonly reauth?: { readonly accountId: string; readonly email: string | undefined };
  readonly onClose: () => void;
}) {
  const hub = HUB_INSTANCES[kind];
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, `Add ${hub.account} account`);
  const provider = providers?.find((candidate) => candidate.instanceId === hub.instanceId);
  const exists = hub.instanceId in settings.providerInstances;
  const creating = useRef(false);

  const createInstance = useEffectEvent(async () => {
    if (creating.current) return;
    creating.current = true;
    const result = await update({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            ...settings.providerInstances,
            [hub.instanceId]: {
              driver: hub.driver,
              displayName: hub.displayName,
              enabled: true,
              config: { enabled: true, setupMode: "hub" },
            },
          },
        },
      },
    });
    creating.current = false;
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: "Could not set up the account hub. Try again." });
      onClose();
    }
  });
  useEffect(() => {
    if (!exists) void createInstance();
  }, [exists]);

  // Close once the hub has the account; the auth flow ends in `succeeded`.
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId: hub.instanceId } }),
  ).data;
  const finish = useEffectEvent(() => {
    toastManager.add({
      type: "success",
      title: reauth
        ? `${reauth.email ?? hub.account} is signed in again`
        : `${hub.account} account added`,
    });
    onClose();
  });
  // A sign-in from an earlier visit may still read `succeeded`; only this visit's counts.
  const signingIn = useRef(false);
  useEffect(() => {
    if (auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying") {
      signingIn.current = true;
    } else if (auth?.phase === "succeeded" && signingIn.current) {
      finish();
    }
  }, [auth?.phase]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <WizardPopup size="wide">
        <WizardHeader
          title={
            reauth
              ? `Sign in to ${reauth.email ?? hub.account} again`
              : `Add ${hub.account} account`
          }
          description={
            reauth
              ? `Its login expired. Sign in with the same ${hub.account} account to fix it; the account keeps its place in the pool.`
              : `Sign in with the ${hub.account} account to add. Signalbox spreads work across every account you add.`
          }
        />
        <WizardPanel>
          {provider ? (
            <HubSignIn
              environmentId={environmentId}
              instanceId={hub.instanceId}
              account={hub.account}
              {...(reauth ? { methodId: hubReauthMethodId(reauth.accountId) } : {})}
            />
          ) : (
            <SettingsRow title="Account hub" description="Setting up the account hub." />
          )}
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
