import * as Schema from "effect/Schema";
import { Offer } from "../runStore/requestSchemas.ts";
import { id } from "../durableState/shared.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { sameCheckpoint } from "../processResume/runStoreState.ts";
import { creationInvocationKey } from "./identity.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessRunStoreResult } from "../HarnessRunStore.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";
import type { HarnessProcessCreationRecoveryInput } from "./contracts.ts";
import type { HarnessProcessCreationEnvironment } from "./contracts.ts";

const Admission = Schema.Struct({
  phase: Schema.Literals(["admitting", "retired"]),
  request: Schema.Struct({ runId: id, operationId: id, request: Offer }),
});
const decode = Schema.decodeUnknownSync(Admission, { onExcessProperty: "error" });
type Admission = typeof Admission.Type;
export async function readUndispatchedCreation(
  storage: DurableObjectStorage,
  recovery: HarnessProcessCreationRecoveryInput,
  journal: HarnessRunStoreResult,
  binding: HarnessProcessCreationBinding,
): Promise<Admission | undefined> {
  const value = await storage.get<unknown>(creationInvocationKey(recovery.runId));
  const requests = journal.snapshot.requests;
  if (!requests || !sameCheckpoint(requests.checkpoint, binding.checkpoint))
    throw new Error("Initial recovery checkpoint changed.");
  const facet = requests.facets.at(-1);
  if (
    !facet ||
    facet.generation !== 1 ||
    facet.operationId !== recovery.operationId ||
    facet.facetNonce !== binding.identity.incarnationNonce
  )
    throw new Error("Initial recovery publisher changed.");
  if (value === undefined && requests.entries.length === 0) return undefined;
  let admission: Admission;
  try {
    admission = decode(value);
  } catch {
    throw new Error("A dispatched initial request requires normal request reconciliation.");
  }
  const entry = requests.entries[0];
  if (
    admission.request.runId !== recovery.runId ||
    admission.request.operationId !== recovery.operationId ||
    requests.entries.length > 1 ||
    (entry !== undefined &&
      (!sameData(entry.request, admission.request.request) ||
        entry.generation !== 1 ||
        entry.facetNonce !== binding.identity.incarnationNonce ||
        !["offered", "withdrawn"].includes(entry.status) ||
        entry.progress !== null ||
        entry.finish !== null ||
        entry.reconciliation !== null))
  )
    throw new Error("Initial recovery cannot retire another or already admitted request.");
  return admission;
}
export async function retireUndispatchedCreation(
  storage: DurableObjectStorage,
  environment: HarnessProcessCreationEnvironment,
  recovery: HarnessProcessCreationRecoveryInput,
  admission: Admission,
  controlKey: string,
) {
  const durable = createHarnessDurableState(environment, recovery.runId);
  const current = await durable.runStore.execute({ type: "read", runId: recovery.runId });
  if (current.snapshot.requests?.entries.length)
    await durable.runStore.execute({
      type: "request.withdraw",
      runId: recovery.runId,
      controlKey: controlKey,
      request: admission.request.request,
    });
  await storage.put(creationInvocationKey(recovery.runId), { ...admission, phase: "retired" });
}
