import type { HarnessProcessResumeOperationInput } from "../processResume/contracts.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import {
  assertNoLegacyProcessResumeForSource,
  readLegacyProcessSource,
  type HarnessLegacyProcessSourceEnvironment,
} from "./legacySource.ts";
import { activeKey, ownedRequestKey, readOwned } from "./ownedRequest.ts";

/** Upgrades a stopped legacy process only while its exact receipts and active source stay put. */
export async function adoptLegacyOwnedRequest(input: {
  readonly storage: DurableObjectStorage;
  readonly environment: HarnessLegacyProcessSourceEnvironment;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly incarnation: ProcessIncarnation;
}) {
  const { storage, operation, incarnation } = input;
  const key = ownedRequestKey(
    operation.runId,
    operation.previousOperationId,
    operation.previousStepId,
  );
  if ((await storage.get(key)) !== undefined) return;
  const { evidence, ...candidate } = await readLegacyProcessSource({
    storage,
    environment: input.environment,
    operation,
    fence: await incarnation.assertCurrent(),
  });
  await storage.transaction(async (transaction) => {
    await incarnation.assertCurrent(transaction);
    if ((await transaction.get(key)) !== undefined) return;
    if ((await transaction.get(activeKey(operation.runId))) !== undefined)
      throw new Error("A different durable process source already owns this run.");
    if (
      !sameData(await transaction.get(candidate.legacySource.terminalKey), evidence.terminal) ||
      !sameData(await transaction.get(candidate.legacySource.completionKey), evidence.completion)
    )
      throw new Error("The legacy process receipts changed during adoption.");
    await assertNoLegacyProcessResumeForSource({
      storage: transaction,
      runId: candidate.runId,
      processId: candidate.process.processId,
      processOperationId: candidate.process.operationId,
      requestId: candidate.request.requestId,
    });
    await transaction.put(key, readOwned(candidate));
    await transaction.put(activeKey(candidate.runId), key);
  });
}
