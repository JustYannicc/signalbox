import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { hubAccountKindForDriver, HUB_INSTANCES } from "./hubInstances";
import { HubSignIn } from "./HubSignIn";

/** Settings for a hub instance: sign in to add an account, manage accounts on Limits. */
export function HubInstanceSetup({
  environmentId,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const navigate = useNavigate();
  const kind = provider ? hubAccountKindForDriver(provider.driver) : null;
  return (
    <section aria-label="Account hub" className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title="Accounts"
        description={
          provider?.auth.label
            ? `${provider.auth.label}. Signalbox spreads work across them.`
            : "Each sign-in adds an account. Signalbox spreads work across them."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/usage" })}>
            Manage accounts
          </Button>
        }
      />
      {provider && kind ? (
        <HubSignIn
          environmentId={environmentId}
          instanceId={instanceId}
          account={HUB_INSTANCES[kind].account}
          disabled={readOnly || !provider.installed}
        />
      ) : (
        <SettingsRow title="Account hub" description="Setting up the account hub." />
      )}
    </section>
  );
}
