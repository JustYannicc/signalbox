/**
 * Settings → Trash (#474): threads and folders the person deleted, each
 * restorable to where it was until it's deleted for good. Deleting for good
 * is the server's call (`purgeEnabled`); while it's off, nothing here goes
 * and the controls that would do it stay hidden.
 *
 * @module TrashSettings
 */
import { useAtomValue } from "@effect/atom-react";
import {
  trashEmptyConfirmation,
  trashEntriesShown,
  trashEntryIsIdle,
  trashEntryState,
  trashEntrySummary,
  trashExplanation,
  trashFailureMessage,
  trashHasPendingWork,
} from "@t3tools/client-runtime/state/signalboxTrash";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TrashEntry, TrashEntryId } from "@t3tools/contracts/signalboxTrash";
import { Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { signalboxTrash, useTrashEnvironmentId } from "~/state/signalboxTrash";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const COMMAND_OPTIONS = { reportFailure: false };
const PENDING_REFRESH_MS = 3_000;

const deletedAgo = (at: number) => formatRelativeTimeLabel(new Date(at).toISOString());

export function TrashSettingsPanel() {
  const environmentId = useTrashEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection id="trash" title="Trash">
          <SettingsRow
            title="Trash"
            description="Connect to Signalbox Cloud to see the threads and folders you deleted."
          />
        </SettingsSection>
      ) : (
        <TrashSection key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

interface Confirming {
  readonly entries: ReadonlyArray<TrashEntry>;
  readonly all: boolean;
}

function TrashSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(signalboxTrash.list({ environmentId, input: {} }));
  const canChange = useAtomValue(signalboxTrash.restore.permissionAtom(environmentId));
  const restore = useAtomCommand(signalboxTrash.restore, COMMAND_OPTIONS);
  const empty = useAtomCommand(signalboxTrash.empty, COMMAND_OPTIONS);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<TrashEntryId>>(() => new Set());
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  // "Deleted 3d ago"; a minute is fine-grained enough.
  const now = useRelativeTimeTick(60_000);

  const { data: snapshot, refresh } = query;
  // Restoring and purging finish on the server; ask again until they have.
  useEffect(() => {
    if (snapshot === null || !trashHasPendingWork(snapshot)) return;
    const handle = setTimeout(refresh, PENDING_REFRESH_MS);
    return () => clearTimeout(handle);
  }, [refresh, snapshot]);

  if (snapshot === null) {
    return (
      <SettingsSection id="trash" title="Trash">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {query.error === null ? <Spinner size="sm" tone="muted" /> : null}
              {query.error === null ? "Loading Trash" : "Could not load Trash"}
            </span>
          }
          status={
            query.error === null ? undefined : (
              <span role="alert" className="text-destructive">
                {query.error}
              </span>
            )
          }
          control={
            query.error === null ? undefined : (
              <Button size="xs" variant="outline" onClick={refresh}>
                Try again
              </Button>
            )
          }
        />
      </SettingsSection>
    );
  }

  const entries = trashEntriesShown(snapshot);
  const chosen = entries.filter((entry) => selected.has(entry.id) && trashEntryIsIdle(entry));
  const idle = entries.filter(trashEntryIsIdle);
  const busy = pending !== null || !canChange;
  const { purgeEnabled } = snapshot;

  const run = async (key: string, command: () => Promise<string | null>) => {
    setPending(key);
    setError(null);
    try {
      const failure = await command();
      setError(failure);
      return failure === null;
    } finally {
      setPending(null);
    }
  };
  const restoreEntry = (entry: TrashEntry) =>
    void run(entry.id, async () =>
      trashFailureMessage(await restore({ environmentId, input: { id: entry.id } })),
    );
  const deleteForGood = async ({ entries: going, all }: Confirming) => {
    setConfirming(null);
    const done = await run(all ? "empty" : "delete", async () =>
      trashFailureMessage(
        await empty({
          environmentId,
          input: all ? {} : { ids: going.map((entry) => entry.id) },
        }),
      ),
    );
    if (done) setSelected(new Set());
  };
  const toggle = (id: TrashEntryId, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const confirmation =
    confirming === null ? null : trashEmptyConfirmation(confirming.entries, confirming.all);

  return (
    <>
      <SettingsSection
        id="trash"
        title="Trash"
        headerAction={
          purgeEnabled && idle.length > 0 ? (
            chosen.length > 0 ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => setConfirming({ entries: chosen, all: false })}
              >
                {pending === "delete" ? "Deleting…" : `Delete ${chosen.length} forever`}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirming({ entries: idle, all: true })}
              >
                {pending === "empty" ? "Emptying…" : "Empty Trash"}
              </Button>
            )
          ) : null
        }
      >
        <SettingsRow
          title={entries.length === 0 ? "Trash is empty" : "Recently deleted"}
          description={trashExplanation(purgeEnabled)}
          status={
            error === null ? undefined : (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            )
          }
        />
        {entries.map((entry) => {
          const state = trashEntryState(entry);
          const isIdle = trashEntryIsIdle(entry);
          return (
            <SettingsRow
              key={entry.id}
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  {purgeEnabled ? (
                    <Checkbox
                      checked={isIdle && selected.has(entry.id)}
                      disabled={busy || !isIdle}
                      aria-label={`Select ${entry.title}`}
                      onCheckedChange={(checked) => toggle(entry.id, checked === true)}
                    />
                  ) : null}
                  <span className="truncate">{entry.title}</span>
                </span>
              }
              description={`${trashEntrySummary(entry, purgeEnabled, now)} · Deleted ${deletedAgo(entry.deletedAt)}`}
              status={
                state === null ? undefined : (
                  <span
                    role={state.failed ? "alert" : "status"}
                    className={state.failed ? "text-destructive" : undefined}
                  >
                    {state.text}
                  </span>
                )
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy || !isIdle}
                  onClick={() => restoreEntry(entry)}
                >
                  {pending === entry.id || entry.status === "restoring" ? "Restoring…" : "Restore"}
                </Button>
              }
            />
          );
        })}
      </SettingsSection>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (confirming !== null) void deleteForGood(confirming);
              }}
            >
              <Trash2Icon className="size-3.5" />
              {confirmation?.confirmText}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
