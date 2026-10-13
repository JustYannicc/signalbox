import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountPool } from "@t3tools/contracts/accountHub";

import { useAccountPools } from "../../state/accountPools";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { MoveNativeLogins } from "./MoveNativeLogins";
import { NewPoolButton, PoolActionsMenu } from "./PoolActions";

function backingText(pool: AccountPool) {
  return pool.backing.mode === "managed"
    ? "Signalbox keeps its logins"
    : `Logins in your CLIProxyAPI at ${new URL(pool.backing.url).host}`;
}

/** Settings → Pools: every pool of the environment, and where each keeps its logins. */
export function PoolsSettings() {
  // Pools belong to one environment; the settings scope picks which.
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return environmentId ? <EnvironmentPools environmentId={environmentId} /> : null;
}

function EnvironmentPools({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pools = useAccountPools(environmentId);
  return (
    <SettingsPageContainer>
      <MoveNativeLogins environmentId={environmentId} framed />
      <SettingsSection
        id="pools"
        title="Pools"
        headerAction={<NewPoolButton environmentId={environmentId} />}
      >
        {pools.map((pool) => (
          <SettingsRow
            key={pool.id}
            title={pool.name}
            description={backingText(pool)}
            control={<PoolActionsMenu environmentId={environmentId} pool={pool} />}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
