import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}

const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];

/** signalbox: a settled task's shell, which lives in the archive rather than the live shell (#671). */
export function useArchivedThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  const environmentId = ref?.environmentId ?? null;
  const environmentIds = useMemo(
    () => (environmentId === null ? NO_ENVIRONMENTS : [environmentId]),
    [environmentId],
  );
  const { snapshots } = useArchivedThreadSnapshots(environmentIds);
  const threadId = ref?.threadId ?? null;
  return useMemo(() => {
    if (environmentId === null || threadId === null) return null;
    const thread = snapshots
      .find((entry) => entry.environmentId === environmentId)
      ?.snapshot.threads.find((candidate) => candidate.id === threadId);
    return thread ? presentThreadShell(environmentId, thread) : null;
  }, [environmentId, snapshots, threadId]);
}
