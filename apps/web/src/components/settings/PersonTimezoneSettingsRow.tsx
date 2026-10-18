import { LegendList, type LegendListRef } from "@legendapp/list/react";
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
import { useRef, useState } from "react";

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
import { SettingResetButton, SettingsRow } from "./settingsLayout";
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
      : `Automatic: ${settings.timezone}, from your devices.`;
  return `${mode} New schedules use it; existing ones keep their time zone.`;
}

function TimezoneSettingsRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settingsResult = useAtomValue(personTimezone.settings({ environmentId, input: {} }));
  const settings = Option.getOrNull(AsyncResult.value(settingsResult));
  const canSet = useAtomValue(personTimezone.set.permissionAtom(environmentId));
  const canReport = useAtomValue(personTimezone.report.permissionAtom(environmentId));
  const setTimezone = useAtomCommand(personTimezone.set);
  const reportTimezone = useAtomCommand(personTimezone.report);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const listRef = useRef<LegendListRef | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices: ReadonlyArray<TimezoneChoice> = [
    AUTOMATIC_CHOICE,
    ...supportedTimezones(settings?.timezone ?? detectDeviceTimezone()).map(
      (zone): TimezoneChoice => ({ kind: "manual", value: zone, label: zone }),
    ),
  ];
  const selectedChoice =
    settings?.source === "manual"
      ? (choices.find((choice) => choice.kind === "manual" && choice.value === settings.timezone) ??
        AUTOMATIC_CHOICE)
      : AUTOMATIC_CHOICE;
  const needle = query.trim().toLocaleLowerCase();
  const filteredChoices = needle
    ? choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle))
    : choices;

  const saveChoice = async (choice: TimezoneChoice) => {
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
        setError(personTimezoneErrorMessage(result.cause, "Couldn't restore automatic time zone."));
      }
      return;
    }

    const result = await setTimezone({ environmentId, input: { timezone: choice.value } });
    if (AsyncResult.isFailure(result)) {
      setError(personTimezoneErrorMessage(result.cause, "Couldn't save this time zone."));
    }
  };

  const choose = async (choice: TimezoneChoice) => {
    if (!settings || saving || !canSet || !canReport) return;
    setSaving(true);
    setError(null);
    await saveChoice(choice).catch(() => {
      setError("Couldn't save this time zone. Try again.");
    });
    setSaving(false);
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
      resetAction={
        settings?.source === "manual" ? (
          <SettingResetButton
            label="time zone"
            tooltip="Use automatic time zone"
            disabled={saving || !canSet || !canReport}
            onClick={() => void choose(AUTOMATIC_CHOICE)}
          />
        ) : undefined
      }
      control={
        <Combobox<TimezoneChoice>
          items={choices}
          filteredItems={filteredChoices}
          autoHighlight
          virtualized
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (nextOpen) setQuery("");
          }}
          onItemHighlighted={(_value, details) => {
            if (!open || details.index < 0 || details.reason !== "keyboard") return;
            void listRef.current?.scrollIndexIntoView({ index: details.index, animated: false });
          }}
          filter={null}
          itemToStringLabel={(choice) => choice.label}
          isItemEqualToValue={(left, right) => left.value === right.value}
          value={selectedChoice}
          disabled={saving || settings === null || !canSet || !canReport}
          onValueChange={(choice) => {
            if (choice) {
              setOpen(false);
              void choose(choice);
            }
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
            <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
              <ComboboxListVirtualized>
                <LegendList<TimezoneChoice>
                  ref={listRef}
                  data={filteredChoices}
                  keyExtractor={(choice) => choice.value}
                  estimatedItemSize={32}
                  drawDistance={360}
                  style={{ height: Math.min(filteredChoices.length * 32, 288) }}
                  renderItem={({ item, index }) => (
                    <ComboboxItem index={index} key={item.value} value={item}>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {selectedChoice.value === item.value ? (
                        <CheckIcon
                          aria-hidden
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                    </ComboboxItem>
                  )}
                />
              </ComboboxListVirtualized>
            </div>
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
