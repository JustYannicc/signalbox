import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProductAnalyticsSettings } from "@t3tools/contracts/signalboxAnalytics";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { productAnalyticsSettings, setProductAnalyticsEnabled } from "./productAnalytics";
import { useShowsEnvironmentUi } from "../state/environmentCapabilities";

const DESCRIPTION =
  "Lets T3 Code and Signalbox collect anonymous usage events in their PostHog projects. Never prompts, responses, or file contents.";

interface EnvironmentAnalytics {
  readonly environmentId: EnvironmentId;
  /** Null while loading, or when the server can't answer (an older server). */
  readonly settings: ProductAnalyticsSettings | null;
  readonly waiting: boolean;
  readonly canChange: boolean;
}

/** Each selected environment's setting; a server sends its own events. */
function useEnvironmentAnalytics(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(
    Atom.make((get) =>
      environmentIds.map((environmentId): EnvironmentAnalytics => {
        const result = get(productAnalyticsSettings({ environmentId, input: {} }));
        return {
          environmentId,
          settings: Option.getOrNull(AsyncResult.value(result)),
          waiting: result.waiting,
          canChange: get(setProductAnalyticsEnabled.permissionAtom(environmentId)),
        };
      }),
    ),
  );
}

function describe(
  environments: readonly EnvironmentAnalytics[],
  showsEnvironmentUi: boolean,
): string {
  if (environments.some((entry) => entry.settings === null && !entry.waiting)) {
    return showsEnvironmentUi
      ? "Couldn't read this setting from every selected environment. Update its server to change it here."
      : "Couldn't read this setting right now.";
  }
  if (environments.every((entry) => entry.settings?.disabledByServer)) {
    return "Turned off on this server by T3CODE_TELEMETRY_ENABLED=false.";
  }
  if (
    environments.every((entry) => entry.settings !== null && !entry.waiting && !entry.canChange)
  ) {
    return "This connection can't change settings.";
  }
  return DESCRIPTION;
}

/**
 * Settings → General: the one product analytics opt-out, saved on every
 * selected environment like other environment settings.
 */
export function ProductAnalyticsSettingsSection() {
  const { connectedEnvironments } = useSettingsScope();
  const environmentIds = connectedEnvironments.map((environment) => environment.environmentId);
  const environments = useEnvironmentAnalytics(environmentIds);
  const setEnabled = useAtomCommand(setProductAnalyticsEnabled);
  const showsEnvironmentUi = useShowsEnvironmentUi();
  const [saving, setSaving] = useState(false);
  if (environments.length === 0) return null;

  // The server's environment variable wins; those servers can't be changed here.
  const changeable = environments.filter((entry) => entry.settings?.disabledByServer === false);
  const editable = changeable.filter((entry) => entry.canChange);
  const values = new Set(changeable.map((entry) => entry.settings?.enabled));
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
        description={describe(environments, showsEnvironmentUi)}
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
