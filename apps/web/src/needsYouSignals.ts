/**
 * signalbox: what earns a person's attention in this client (#43). Questions,
 * approvals and failures always do, and their toasts stay until the person
 * acts on them or dismisses them. A finished turn only does when a person
 * started the thread here and the turn ran long enough that nobody sat
 * watching it, the same rule the phone push follows.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { useEffect, useState } from "react";

/** Matches `LONG_TURN_MS` in apps/cloud/src/push/pushRules.ts. */
const LONG_TURN_MS = 60_000;

/** Whether a finished turn earns a signal: a person's own thread, and a long turn. */
export function completionEarnsSignal(
  thread: Pick<EnvironmentThreadShell, "latestRun"> & {
    readonly source: Pick<EnvironmentThreadShell["source"], "creationSource">;
  },
): boolean {
  // Automations start threads from the server, agents from MCP or the provider.
  const startedByPerson =
    thread.source.creationSource === "web" || thread.source.creationSource === "mobile";
  const startedAt = Date.parse(thread.latestRun?.startedAt ?? "");
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  return (
    startedByPerson &&
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    completedAt - startedAt >= LONG_TURN_MS
  );
}

/** A toast that needs the person stays; a completion leaves on the toast default. */
export function needsYouToastTimeout(kind: "completion" | "input"): number | undefined {
  return kind === "input" ? 0 : undefined;
}

/**
 * The toasts a thread's question, approval or failure raised. Each closes once
 * its thread stops waiting on that same thing (answered, approved, retried) or
 * the person opens the thread.
 */
export function createNeedsYouToasts(close: (toastId: string) => void) {
  const open = new Map<string, { readonly toastId: string; readonly attention: string }>();
  return {
    add(threadKey: string, attention: string, toastId: string) {
      const previous = open.get(threadKey);
      if (previous !== undefined && previous.toastId !== toastId) close(previous.toastId);
      open.set(threadKey, { toastId, attention });
    },
    sync(threadKey: string, attention: string | null, viewing: boolean) {
      const entry = open.get(threadKey);
      if (entry === undefined || (!viewing && entry.attention === attention)) return;
      close(entry.toastId);
      open.delete(threadKey);
    },
    /** Closes the toasts of threads that left the snapshot (deleted, moved away). */
    retain(threadKeys: ReadonlySet<string>) {
      for (const [threadKey, entry] of open) {
        if (threadKeys.has(threadKey)) continue;
        close(entry.toastId);
        open.delete(threadKey);
      }
    },
    /** A zero-timeout toast must not outlive the tracker that can close it. */
    closeAll() {
      for (const entry of open.values()) close(entry.toastId);
      open.clear();
    },
  };
}

type NeedsYouToasts = ReturnType<typeof createNeedsYouToasts>;

/**
 * One environment's toast tracker. Its zero-timeout toasts close when in-app
 * notifications are turned off (desktop alerts can keep the component mounted)
 * and when it unmounts (all notifications off, environment gone).
 */
export function useNeedsYouToasts(
  close: (toastId: string) => void,
  inAppNotificationsEnabled: boolean,
): NeedsYouToasts {
  const [toasts] = useState(() => createNeedsYouToasts(close));
  useEffect(() => {
    if (!inAppNotificationsEnabled) toasts.closeAll();
  }, [inAppNotificationsEnabled, toasts]);
  useEffect(() => () => toasts.closeAll(), [toasts]);
  return toasts;
}

const ADOPTED_KEY = "signalbox:needs-you-defaults:v1";

/**
 * Any successful settings write holds the person's choice from then on, so a
 * migration that couldn't write earlier must not flip it on the next load.
 */
export function markNeedsYouDefaultsAdopted(
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(ADOPTED_KEY, "1");
  } catch {
    // Unwritable storage retries next load; flipping an unsaved default again is harmless.
  }
}

/**
 * In-app notifications became the default with #43. Settings saved before then
 * hold the old default, not a choice, so they're turned on once; turning them
 * off afterwards sticks. A device with nothing saved already has the new
 * default, so it only records the adoption. The adoption is recorded only once
 * `persist` has written the settings back, so a failed write retries on the
 * next load.
 */
export async function adoptNeedsYouDefaults(
  settings: ClientSettings | null,
  persist: (settings: ClientSettings) => void | Promise<void>,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): Promise<ClientSettings | null> {
  if (storage === undefined) return settings;
  const markAdopted = () => markNeedsYouDefaultsAdopted(storage);
  try {
    if (storage.getItem(ADOPTED_KEY) !== null) return settings;
  } catch {
    return settings;
  }
  if (settings === null || settings.inAppNotificationsEnabled) {
    markAdopted();
    return settings;
  }
  const adopted = { ...settings, inAppNotificationsEnabled: true };
  try {
    await persist(adopted);
  } catch {
    return adopted;
  }
  markAdopted();
  return adopted;
}
