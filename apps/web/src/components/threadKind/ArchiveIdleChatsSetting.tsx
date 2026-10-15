/**
 * signalbox: Settings → General → Organization: how long chats may idle
 * before they archive themselves (#46). Saved on every selected environment
 * that keeps kinds; hidden where none does.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  DEFAULT_ARCHIVE_CHATS_AFTER_DAYS,
  type ArchiveChatsAfterDays,
} from "@t3tools/contracts/signalboxThreadKinds";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import {
  environmentThreadKindsAtom,
  setArchiveChatsAfterDays,
  signalboxThreadKinds,
} from "../../state/signalboxThreadKinds";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { archiveChatsAfterDaysChoices, archiveChatsAfterDaysLabel } from "./threadKind.logic";

interface EnvironmentChatArchive {
  readonly environmentId: EnvironmentId;
  readonly days: ArchiveChatsAfterDays;
  readonly canChange: boolean;
}

/** The selected environments that keep kinds and have sent them. */
function useEnvironmentChatArchive(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environmentIds.flatMap((environmentId): EnvironmentChatArchive[] => {
            const snapshot = get(environmentThreadKindsAtom(environmentId));
            if (snapshot === null) return [];
            return [
              {
                environmentId,
                days: snapshot.archiveChatsAfterDays,
                canChange: get(
                  signalboxThreadKinds.setArchiveChatsAfterDays.permissionAtom(environmentId),
                ),
              },
            ];
          }),
        ),
      [environmentIds],
    ),
  );
}

const choiceValue = (days: ArchiveChatsAfterDays) => (days === null ? "never" : String(days));

export function ArchiveIdleChatsSetting() {
  const { connectedEnvironments } = useSettingsScope();
  const environmentIds = useMemo(
    () => connectedEnvironments.map((environment) => environment.environmentId),
    [connectedEnvironments],
  );
  const environments = useEnvironmentChatArchive(environmentIds);
  const [saving, setSaving] = useState(false);
  if (environments.length === 0) return null;

  const editable = environments.filter((entry) => entry.canChange);
  const values = new Set(environments.map((entry) => entry.days));
  const current = environments[0]!.days;
  const choices = archiveChatsAfterDaysChoices(current);

  const change = (days: ArchiveChatsAfterDays) => {
    setSaving(true);
    void Promise.all(editable.map((entry) => setArchiveChatsAfterDays(entry.environmentId, days)))
      .then((results) => {
        if (results.some((result) => result._tag === "Failure")) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save when chats archive",
              description: "Some environments kept their previous setting.",
            }),
          );
        }
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsRow
      id="archive-idle-chats"
      title="Archive idle chats after"
      description="Chats nobody touches for this long move to Archived. Tasks never do; they leave through Done."
      mixed={values.size > 1}
      resetAction={
        values.size === 1 && current !== DEFAULT_ARCHIVE_CHATS_AFTER_DAYS ? (
          <SettingResetButton
            label="archive idle chats"
            onClick={() => change(DEFAULT_ARCHIVE_CHATS_AFTER_DAYS)}
          />
        ) : null
      }
      control={
        <Select
          value={choiceValue(current)}
          disabled={saving || editable.length === 0}
          onValueChange={(value) => {
            const days = choices.find((choice) => choiceValue(choice) === value);
            if (days !== undefined) change(days);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Archive idle chats after">
            <SelectValue>{archiveChatsAfterDaysLabel(current)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((days) => (
              <SelectItem hideIndicator key={choiceValue(days)} value={choiceValue(days)}>
                {archiveChatsAfterDaysLabel(days)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
