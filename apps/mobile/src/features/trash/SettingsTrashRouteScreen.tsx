import {
  trashEmptyConfirmation,
  trashEntriesShown,
  trashEntryIsIdle,
  trashEntryRestorable,
  trashEntryState,
  trashEntrySummary,
  trashExplanation,
  trashFailureMessage,
  trashHasPendingWork,
} from "@t3tools/client-runtime/state/signalboxTrash";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TrashEntry } from "@t3tools/contracts/signalboxTrash";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { signalboxTrash, useTrashEnvironments } from "../../state/signalboxTrash";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

/**
 * Settings → Trash (#474), the web's Settings → Trash: threads and folders
 * you deleted, each restorable to where it was until it's deleted for good.
 * Deleting for good only shows while the server has it on (`purgeEnabled`).
 */
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };
const PENDING_REFRESH_MS = 3_000;

export function SettingsTrashRouteScreen() {
  const environments = useTrashEnvironments();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Trash">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <Text className="px-2 text-foreground-muted">
            Connect to Signalbox Cloud to see the threads and folders you deleted.
          </Text>
        ) : (
          environments.map((environment) => (
            <Trash
              key={environment.environmentId}
              environmentId={environment.environmentId}
              title={environments.length > 1 ? environment.label : "Recently deleted"}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function Trash({
  environmentId,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}) {
  const query = useEnvironmentQuery(signalboxTrash.list({ environmentId, input: {} }));
  const canChange = useAtomValue(signalboxTrash.restore.permissionAtom(environmentId));
  const restore = useAtomCommand(signalboxTrash.restore, COMMAND_OPTIONS);
  const empty = useAtomCommand(signalboxTrash.empty, COMMAND_OPTIONS);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { data: snapshot, refresh } = query;
  // Restoring and purging finish on the server; ask again until they have.
  useEffect(() => {
    if (snapshot === null || !trashHasPendingWork(snapshot)) return;
    const handle = setTimeout(refresh, PENDING_REFRESH_MS);
    return () => clearTimeout(handle);
  }, [refresh, snapshot]);

  if (snapshot === null) {
    return (
      <Text className="px-2 text-foreground-muted">
        {query.error ? `Couldn't load Trash: ${query.error}` : "Loading…"}
      </Text>
    );
  }

  const entries = trashEntriesShown(snapshot);
  const idle = entries.filter(trashEntryIsIdle);
  const busy = pending !== null || !canChange;
  const { purgeEnabled } = snapshot;

  const run = async (key: string, command: () => Promise<string | null>) => {
    setPending(key);
    setError(null);
    try {
      setError(await command());
    } finally {
      setPending(null);
    }
  };
  const restoreEntry = (entry: TrashEntry) =>
    void run(entry.id, async () =>
      trashFailureMessage(await restore({ environmentId, input: { id: entry.id } })),
    );
  const confirmDelete = (going: ReadonlyArray<TrashEntry>, all: boolean) => {
    const { title, message, confirmText } = trashEmptyConfirmation(going, all);
    Dialog.confirm({
      title,
      message,
      confirmText,
      destructive: true,
      onConfirm: () =>
        void run(all ? "empty" : (going[0]?.id ?? "delete"), async () =>
          trashFailureMessage(
            await empty({
              environmentId,
              input: all ? {} : { ids: going.map((entry) => entry.id) },
            }),
          ),
        ),
    });
  };
  // A tap offers what can be done with the entry; deleting it for good asks again.
  const choose = (entry: TrashEntry) =>
    Dialog.alert(entry.title, trashEntrySummary(entry, purgeEnabled, now), [
      { text: "Cancel", style: "cancel" },
      ...(purgeEnabled
        ? [
            {
              text: "Delete forever",
              style: "destructive" as const,
              onPress: () => confirmDelete([entry], false),
            },
          ]
        : []),
      ...(trashEntryRestorable(entry, now)
        ? [{ text: "Restore", onPress: () => restoreEntry(entry) }]
        : []),
    ]);

  return (
    <>
      <SettingsSection title={title} footer={trashExplanation(purgeEnabled)}>
        {entries.length === 0 ? (
          <Text className="px-4 py-4 text-foreground-muted">Trash is empty.</Text>
        ) : (
          entries.map((entry) => {
            const state = trashEntryState(entry);
            const description = [
              `${trashEntrySummary(entry, purgeEnabled, now)} · Deleted ${relativeTime(new Date(entry.deletedAt).toISOString())} ago`,
              state?.text,
            ]
              .filter((part): part is string => part !== undefined)
              .join("\n");
            return (
              <SettingsActionRow
                key={entry.id}
                icon={entry.kind === "folder" ? "folder" : "text.bubble"}
                label={entry.title}
                description={description}
                tone={state?.failed ? "danger" : "default"}
                loading={pending === entry.id || !trashEntryIsIdle(entry)}
                disabled={busy}
                onPress={() => choose(entry)}
              />
            );
          })
        )}
      </SettingsSection>

      {error === null ? null : <Text className="px-2 text-sm text-danger-foreground">{error}</Text>}

      {purgeEnabled && idle.length > 0 ? (
        <SettingsSection>
          <SettingsActionRow
            icon="trash"
            label={pending === "empty" ? "Emptying…" : "Empty Trash"}
            tone="danger"
            loading={pending === "empty"}
            disabled={busy}
            onPress={() => confirmDelete(idle, true)}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
