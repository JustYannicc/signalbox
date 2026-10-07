import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { isMovableNativeLogin, nativeLoginLabel } from "./nativeLogins";

/**
 * Setup for a provider that is not a pool's: it never offers a sign-in of its
 * own. A signed-in one is moved by the Move row at the top of the page;
 * anything else points at pools.
 */
export function NativeProviderSetup({
  environmentId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const navigate = useNavigate();
  const instances = useEnvironmentSettings(environmentId, (settings) => settings.providerInstances);
  if (provider && isMovableNativeLogin(provider, instances)) {
    return (
      <SettingsRow
        title="Signed in on the server"
        description={`${nativeLoginLabel(provider)} signs in on the server itself. Move it into a pool with the Move row at the top of this page.`}
      />
    );
  }
  return (
    <SettingsRow
      title="Accounts"
      description="Accounts live in pools. Add one from Usage → Limits, and pick its pool in the model picker."
      control={
        readOnly ? undefined : (
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/usage" })}>
            Add account
          </Button>
        )
      }
    />
  );
}
