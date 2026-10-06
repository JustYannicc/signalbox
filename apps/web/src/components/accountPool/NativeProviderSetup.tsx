import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { MOVABLE_NATIVE_DRIVERS } from "@t3tools/contracts/accountHub";
import { useNavigate } from "@tanstack/react-router";

import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { MoveNativeLogins } from "./MoveNativeLogins";

/**
 * Setup for a provider that is not a pool's: it never offers a sign-in of its
 * own. A signed-in one can move into a pool; anything else points at pools.
 */
export function NativeProviderSetup({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const navigate = useNavigate();
  if (
    provider?.enabled &&
    provider.auth.status === "authenticated" &&
    MOVABLE_NATIVE_DRIVERS.includes(provider.driver)
  ) {
    return <MoveNativeLogins environmentId={environmentId} instanceIds={[instanceId]} />;
  }
  return (
    <SettingsRow
      title="Accounts"
      description="Accounts live in pools. Add one from Usage → Limits, and pick its pool in the model picker."
      control={
        <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/usage" })}>
          Add account
        </Button>
      }
    />
  );
}
