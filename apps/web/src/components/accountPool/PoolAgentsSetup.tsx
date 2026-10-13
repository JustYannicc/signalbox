import type { EnvironmentId } from "@t3tools/contracts";

import { AddHubAccountMenu } from "../accountHub/AddHubAccountMenu";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow } from "../settings/settingsLayout";
import { MoveNativeLogins } from "./MoveNativeLogins";

/**
 * The welcome wizard's agents step for one computer: agents run on the
 * accounts in its pool, so setup means moving any sign-ins the computer
 * already has into the pool, or adding accounts.
 */
export function PoolAgentsSetup({
  environmentId,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      <SettingsGroup divided={false} className="overflow-hidden">
        <MoveNativeLogins environmentId={environmentId} />
        <SettingsRow
          title="Accounts"
          description="Add a ChatGPT, Claude, Grok, Antigravity, or Cursor account, or an API key. Agents spread work across every account in the pool."
          control={<AddHubAccountMenu environmentId={environmentId} />}
        />
      </SettingsGroup>
    </section>
  );
}
