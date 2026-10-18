// signalbox: settling archives a thread (#671). Thread lists keep it on their settled shelf, so it can be reopened in place.
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../archive/useArchivedThreadSnapshots";

/** Settled threads from the archive, as list shells. */
export function settledArchivedThreads(
  archived: ReadonlyArray<ArchivedSnapshotEntry>,
): ReadonlyArray<EnvironmentThreadShell> {
  return archived.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads
      .filter((thread) => thread.settledOverride === "settled")
      .map((thread) => presentThreadShell(environmentId, thread)),
  );
}

/** Live shells plus settled archived ones; a live shell wins when both have the thread. */
export function withSettledArchivedThreads(
  live: ReadonlyArray<EnvironmentThreadShell>,
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === 0) return live;
  const liveKeys = new Set(live.map((thread) => scopedThreadKey(thread.environmentId, thread.id)));
  const added = settled.filter(
    (thread) => !liveKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
  );
  return added.length === 0 ? live : [...live, ...added];
}

export function useWithSettledArchivedThreads(
  live: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentIds = useMemo(
    () => Object.values(savedConnectionsById).map((connection) => connection.environmentId),
    [savedConnectionsById],
  );
  const { snapshots } = useArchivedThreadSnapshots(environmentIds);
  const settled = useMemo(() => settledArchivedThreads(snapshots), [snapshots]);

  // A done-condition archives tasks on the server: a thread leaving the live list is the cue to refetch its archive.
  const previousLive = useRef(live);
  useEffect(() => {
    const previous = previousLive.current;
    previousLive.current = live;
    if (previous === live) return;
    const current = new Set(live.map((thread) => scopedThreadKey(thread.environmentId, thread.id)));
    const left = new Set<EnvironmentId>();
    for (const thread of previous)
      if (!current.has(scopedThreadKey(thread.environmentId, thread.id)))
        left.add(thread.environmentId);
    for (const environmentId of left) refreshArchivedThreadsForEnvironment(environmentId);
  }, [live]);

  return useMemo(() => withSettledArchivedThreads(live, settled), [live, settled]);
}
