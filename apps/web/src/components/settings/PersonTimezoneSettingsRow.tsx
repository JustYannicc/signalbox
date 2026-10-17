import { LegendList } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
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
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { personTimezone } from "../../state/personTimezone";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

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

function TimezoneSettingsRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settingsResult = useAtomValue(personTimezone.settings({ environmentId, input: {} }));
  const settings = Option.getOrNull(AsyncResult.value(settingsResult));
  const canSet = useAtomValue(personTimezone.set.permissionAtom(environmentId));
  const canReport = useAtomValue(personTimezone.report.permissionAtom(environmentId));
  const setTimezone = useAtomCommand(personTimezone.set);
  const reportTimezone = useAtomCommand(personTimezone.report);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo<ReadonlyArray<TimezoneChoice>>(() => {
    const zones = supportedTimezones(settings?.timezone ?? detectDeviceTimezone());
    return [
      AUTOMATIC_CHOICE,
      ...zones.map((zone): TimezoneChoice => ({ kind: "manual", value: zone, label: zone })),
    ];
  }, [settings?.timezone]);
  const selectedChoice =
    settings?.source === "manual"
      ? (choices.find((choice) => choice.kind === "manual" && choice.value === settings.timezone) ??
        AUTOMATIC_CHOICE)
      : AUTOMATIC_CHOICE;
  const filteredChoices = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle))
      : choices;
  }, [choices, query]);

  const choose = async (choice: TimezoneChoice) => {
    if (!settings || saving || !canSet || !canReport) return;
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
        : undefined;

  return (
    <SettingsRow
      {...searchableSetting("person-timezone")}
      description={description}
      status={status}
      control={
        <Combobox<TimezoneChoice>
          items={choices}
          filteredItems={filteredChoices}
          filter={null}
          itemToStringLabel={(choice) => choice.label}
          isItemEqualToValue={(left, right) => left.value === right.value}
          value={selectedChoice}
          disabled={saving || settings === null || !canSet || !canReport}
          onValueChange={(choice) => {
            if (choice) void choose(choice);
          }}
        >
          <div className="max-w-52">
            <ComboboxTrigger aria-label="Time zone" render={<SelectButton size="sm" />}>
              <span className="max-w-44 truncate">{selectedChoice.label}</span>
            </ComboboxTrigger>
          </div>
          <ComboboxPopup align="end" className="flex w-80 flex-col">
            <ComboboxSearchInput
              aria-label="Search time zones"
              placeholder="Search time zones"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>No matching time zones.</ComboboxEmpty>
            <ComboboxListVirtualized>
              <LegendList<TimezoneChoice>
                data={filteredChoices}
                keyExtractor={(choice) => choice.value}
                estimatedItemSize={32}
                drawDistance={360}
                style={{ height: Math.min(filteredChoices.length * 32, 288) }}
                renderItem={({ item, index }) => (
                  <ComboboxItem index={index} key={item.value} value={item}>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {selectedChoice.value === item.value ? (
                      <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                  </ComboboxItem>
                )}
              />
            </ComboboxListVirtualized>
          </ComboboxPopup>
        </Combobox>
      }
    />
  );
}

export function PersonTimezoneSettingsRow() {
  const { connectedEnvironments } = useSettingsScope();
  const environment = connectedEnvironments.find(
    (entry) =>
      entry.serverConfig !== null &&
      supportsPersonTimezone(entry.serverConfig.environment.capabilities),
  );
  return environment ? <TimezoneSettingsRow environmentId={environment.environmentId} /> : null;
}
