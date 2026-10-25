import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorControlClaim } from "../HarnessThreadSupervisor.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import type { HarnessDurableStateStubs } from "./types.ts";
import { HarnessDurableStateError, failureOf } from "./errors.ts";

export type ControlSyncResult =
  | {
      readonly status: "synced";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly files: HarnessFilesStoreResult;
    }
  | {
      readonly status: "files-pending";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly failure: { readonly code: string; readonly message: string };
    };

export async function syncPendingControl(
  stores: HarnessDurableStateStubs,
  control: HarnessThreadSupervisorControlClaim,
  current: HarnessThreadSupervisorResult,
): Promise<ControlSyncResult> {
  const pending = current.snapshot.pendingControlSync;
  if (!pending) throw new HarnessDurableStateError({ code: "OUT_OF_ORDER" });
  if (
    control.ownerId !== current.snapshot.ownerId ||
    control.epoch !== pending.toEpoch ||
    control.incarnationId !== pending.toIncarnationId ||
    pending.fromEpoch + 1 !== pending.toEpoch ||
    pending.fromIncarnationId === pending.toIncarnationId
  )
    throw new HarnessDurableStateError({ code: "STALE_CONTROL" });

  let files: HarnessFilesStoreResult;
  try {
    files = await stores.filesStore.execute({
      type: "syncControl",
      runId: stores.runId,
      control,
      fromEpoch: pending.fromEpoch,
      fromIncarnationId: pending.fromIncarnationId,
      expectedGeneration: pending.expectedGeneration,
      operationId: pending.operationId,
      publication: pending.publication,
      preparedPublication: pending.preparedPublication,
    });
    const supervisor = await stores.threadSupervisor.execute({
      type: "confirmControlSync",
      runId: stores.runId,
      control,
      fromEpoch: pending.fromEpoch,
      fromIncarnationId: pending.fromIncarnationId,
      expectedGeneration: pending.expectedGeneration,
      operationId: pending.operationId,
      publication: pending.publication,
      preparedPublication: pending.preparedPublication,
    });
    if (supervisor.snapshot.pendingControlSync !== null)
      throw new HarnessDurableStateError({ code: "CONFLICT" });
    return { status: "synced", supervisor, files };
  } catch (error) {
    return { status: "files-pending", supervisor: current, failure: failureOf(error) };
  }
}
