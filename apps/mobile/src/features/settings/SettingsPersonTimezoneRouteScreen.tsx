import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  detectDeviceTimezone,
  personTimezoneErrorMessage,
  supportedTimezones,
  supportsPersonTimezone,
} from "@t3tools/client-runtime/personTimezone";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PersonTimezoneSettings } from "@t3tools/contracts/personTimezone";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SearchField } from "../../components/ui/SearchField";
import { useAtomCommand } from "../../state/use-atom-command";
import { personTimezone } from "../../state/personTimezone";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

type TimezoneChoice =
  | { readonly kind: "automatic"; readonly value: "automatic"; readonly label: "Automatic" }
  | { readonly kind: "manual"; readonly value: string; readonly label: string };

const AUTOMATIC_CHOICE: TimezoneChoice = {
  kind: "automatic",
  value: "automatic",
  label: "Automatic",
};

function describeTimezone(settings: PersonTimezoneSettings): string {
  const mode =
    settings.source === "manual"
      ? `Manual: ${settings.timezone}.`
      : `Automatic follows the latest connected client; currently ${settings.timezone}.`;
  return `${mode} New schedules use this time zone. Existing schedules keep their saved time zone.`;
}

export function SettingsPersonTimezoneRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environment = selectedTargets.find((target) =>
    supportsPersonTimezone(target.serverConfig.environment.capabilities),
  );

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Time zone" trailing={<AndroidSettingsEnvironmentFilter />}>
        {environment ? (
          <PersonTimezoneChoices environmentId={environment.environmentId} />
        ) : (
          <View className="px-5 py-4">
            <Text className="text-sm leading-normal text-foreground-muted">
              Select an environment that supports time zone settings.
            </Text>
          </View>
        )}
      </SettingsScreen>
    </>
  );
}

function PersonTimezoneChoices({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const settingsResult = useAtomValue(personTimezone.settings({ environmentId, input: {} }));
  const settings = Option.getOrNull(AsyncResult.value(settingsResult));
  const canSet = useAtomValue(personTimezone.set.permissionAtom(environmentId));
  const canReport = useAtomValue(personTimezone.report.permissionAtom(environmentId));
  const setTimezone = useAtomCommand(personTimezone.set);
  const reportTimezone = useAtomCommand(personTimezone.report);
  const inputRef = useRef<TextInputInstance>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo<ReadonlyArray<TimezoneChoice>>(
    () => [
      AUTOMATIC_CHOICE,
      ...supportedTimezones().map((zone): TimezoneChoice => ({
        kind: "manual",
        value: zone,
        label: zone,
      })),
    ],
    [],
  );
  const filteredChoices = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle))
      : choices;
  }, [choices, query]);
  const selectedValue = settings?.source === "manual" ? settings.timezone : "automatic";
  const disabled = saving || settings === null || !canSet || !canReport;
  const description = settings
    ? describeTimezone(settings)
    : settingsResult.waiting
      ? "Loading time zone…"
      : AsyncResult.isFailure(settingsResult)
        ? personTimezoneErrorMessage(
            settingsResult.cause,
            "Couldn't read the time zone from this connection.",
          )
        : "Couldn't read the time zone from this connection.";
  const status = error
    ? error
    : settingsResult.waiting && settings === null
      ? "Loading…"
      : !canSet || !canReport
        ? "This connection can't change time zone settings."
        : null;

  const choose = async (choice: TimezoneChoice) => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      if (choice.kind === "automatic") {
        const timezone = detectDeviceTimezone();
        if (!timezone) {
          setError("Couldn't detect this device's time zone. Try again when it is available.");
          return;
        }
        const report = await reportTimezone({ environmentId, input: { timezone } });
        if (AsyncResult.isFailure(report)) {
          setError(
            personTimezoneErrorMessage(
              report.cause,
              "Couldn't report this device's time zone. Try again.",
            ),
          );
          return;
        }
        const result = await setTimezone({ environmentId, input: { timezone: null } });
        if (AsyncResult.isFailure(result)) {
          setError(
            personTimezoneErrorMessage(result.cause, "Couldn't restore automatic time zone."),
          );
        }
        return;
      }

      const result = await setTimezone({ environmentId, input: { timezone: choice.value } });
      if (AsyncResult.isFailure(result)) {
        setError(personTimezoneErrorMessage(result.cause, "Couldn't save this time zone."));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <LegendList<TimezoneChoice>
      alwaysBounceVertical={false}
      automaticallyAdjustsScrollIndicatorInsets
      automaticallyAdjustKeyboardInsets
      className="flex-1 bg-sheet android:bg-sheet-solid"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      data={filteredChoices}
      estimatedItemSize={56}
      keyExtractor={(choice) => choice.value}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View className="gap-3 px-5 pb-4 pt-4">
          <Text className="text-sm leading-normal text-foreground-muted">{description}</Text>
          <SearchField
            inputRef={inputRef}
            autoFocus={false}
            accessibilityLabel="Search time zones"
            clearAccessibilityLabel="Clear time zone search"
            placeholder="Search time zones"
            value={query}
            onChangeText={setQuery}
          />
          {status ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {status}
            </Text>
          ) : null}
          {filteredChoices.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No matching time zones.</Text>
          ) : null}
        </View>
      }
      renderItem={({ item, index }) => (
        <ListChoiceRow
          label={item.label}
          description={
            item.kind === "automatic" ? "Follows the latest connected client." : undefined
          }
          selected={selectedValue === item.value}
          separated={index > 0}
          disabled={disabled}
          onPress={() => void choose(item)}
        />
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}
