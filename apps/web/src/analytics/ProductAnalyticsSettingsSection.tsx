import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProductAnalyticsSettings } from "@t3tools/contracts/signalboxAnalytics";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { productAnalyticsSettings, setProductAnalyticsEnabled } from "./productAnalytics";

const DESCRIPTION =
  "Anonymous usage events go to T3 Code's and Signalbox's PostHog projects. No prompts, responses, or file contents. Turning this off stops both.";

interface EnvironmentAnalytics {
  readonly environmentId: EnvironmentId;
  /** Null while loading, or when the server can't answer (an older server). */
  readonly settings: ProductAnalyticsSettings | null;
  readonly waiting: boolean;
}

/** Each selected environment's setting; a server sends its own events. */
function useEnvironmentAnalytics(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environmentIds.map((environmentId): EnvironmentAnalytics => {
            const result = get(productAnalyticsSettings({ environmentId, input: {} }));
            return {
              environmentId,
              settings: Option.getOrNull(AsyncResult.value(result)),
              waiting: result.waiting,
            };
          }),
        ),
      [environmentIds],
    ),
  );
}

function describe(environments: readonly EnvironmentAnalytics[]): string {
  if (environments.some((entry) => entry.settings === null && !entry.waiting)) {
    return "Couldn't read this setting from every selected environment. Update its server to change it here.";
  }
  if (environments.every((entry) => entry.settings?.disabledByServer)) {
    return "Turned off on this server by T3CODE_TELEMETRY_ENABLED=false.";
  }
  return DESCRIPTION;
}

/**
 * Settings → General: the one product analytics opt-out, saved on every
 * selected environment like other environment settings.
 */
export function ProductAnalyticsSettingsSection() {
  const { connectedEnvironments } = useSettingsScope();
  const environmentIds = useMemo(
    () => connectedEnvironments.map((environment) => environment.environmentId),
    [connectedEnvironments],
  );
  const environments = useEnvironmentAnalytics(environmentIds);
  const setEnabled = useAtomCommand(setProductAnalyticsEnabled);
  const [saving, setSaving] = useState(false);
  if (environments.length === 0) return null;

  // The server's environment variable wins; those servers can't be changed here.
  const editable = environments.filter((entry) => entry.settings?.disabledByServer === false);
  const values = new Set(editable.map((entry) => entry.settings?.enabled));
  const loading = environments.some((entry) => entry.settings === null && entry.waiting);

  const change = (enabled: boolean) => {
    setSaving(true);
    void Promise.allSettled(
      editable.map((entry) =>
        setEnabled({ environmentId: entry.environmentId, input: { enabled } }),
      ),
    ).finally(() => setSaving(false));
  };

  return (
    <SettingsSection id="privacy" title="Privacy">
      <SettingsRow
        id="product-analytics"
        title="Share usage analytics"
        description={describe(environments)}
        mixed={values.size > 1}
        control={
          <Switch
            aria-label="Share usage analytics"
            checked={values.has(true)}
            disabled={loading || editable.length === 0 || saving}
            onCheckedChange={change}
          />
        }
      />
    </SettingsSection>
  );
}
