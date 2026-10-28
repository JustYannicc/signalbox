import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { NormalizedContinuation } from "../processResume/continuation.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import { processBoundaryKey, type ProcessBoundary } from "./boundary.ts";
import { retireEvictedBoundary } from "./restore.ts";
import { sameData } from "../processResume/checkpointContract.ts";

export async function stopEvictedProcess(input: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly incarnation: ProcessIncarnation;
  readonly boundary: ProcessBoundary;
  readonly request: NormalizedContinuation;
}) {
  const { context, boundary, request } = input;
  const key = `harness-process-evicted-stop/v1/${encodeURIComponent(boundary.runId)}/${encodeURIComponent(request.runStore.request.requestId)}`;
  const previous = await context.storage.get<{
    readonly request: NormalizedContinuation;
    readonly phase: string;
  }>(key);
  if (previous !== undefined) {
    if (previous.phase !== "stopped" || !sameData(previous.request, request))
      throw new Error("The evicted stop is uncertain or belongs to another request.");
    await input.incarnation.assertCurrent();
    const current = await createHarnessDurableState(
      input.environment,
      boundary.runId,
    ).threadSupervisor.execute({ type: "read", runId: boundary.runId, control: request.control });
    if (current.snapshot.lifecycle !== "recoverable" || current.snapshot.admittedStepId !== null)
      throw new Error("The stopped process no longer has the same durable authority.");
    return { status: "stopped" as const };
  }
  if (
    boundary.phase !== "idle" ||
    boundary.lastRequest === undefined ||
    !sameData(boundary.lastRequest.request, request.runStore.request)
  )
    throw new Error("The stop does not identify the last completed idle request.");
  const durable = createHarnessDurableState(input.environment, boundary.runId);
  await context.storage.put(key, { request, phase: "reserved" });
  const currentFence = await retireEvictedBoundary({
    ...input,
    durable,
    operationId: `eviction-stop-${boundary.fence.incarnation}-${request.runStore.request.requestId}`,
  });
  // Destruction is the cleanup evidence. No native stop RPC or graceful-join reply is invented.
  await context.storage.transaction(async (transaction) => {
    await input.incarnation.assertCurrent();
    await transaction.put(key, {
      request,
      phase: "stopped",
      sourceFence: boundary.fence,
      observedBy: currentFence,
    });
    await transaction.put(processBoundaryKey(boundary.runId), { ...boundary, phase: "stopped" });
  });
  return { status: "stopped" as const };
}
