import * as Schema from "effect/Schema";
import { equals } from "effect/Equal";
import {
  creationPlacementKey,
  HarnessProcessCreationJournal,
} from "../../HarnessProcessCreation.ts";
import type { HarnessProcessPlacementWriter } from "../../HarnessProcessPlacement.ts";
import type { parseEvictedRecoveryReceipt } from "../../HarnessProcessPlacementEvidence.ts";

type ProcessFence = ReturnType<typeof parseEvictedRecoveryReceipt>["sourceFence"];
const text = Schema.NonEmptyString;
const natural = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const control = Schema.Struct({
  ownerId: text,
  incarnationId: text,
  epoch: natural,
  controlKey: text,
});
const writer = Schema.Struct({
  executionOperationId: text,
  shardIndex: natural,
  shardIncarnationNonce: text,
  controllerClaim: control,
});
const identity = Schema.Struct({
  shardOwner: text,
  loaderId: text,
  facetKey: text,
  incarnationNonce: text,
});
const artifact = Schema.Struct({ id: text, sha256: text, bytes: natural });
const checkpoint = Schema.Struct({ native: artifact, filesystem: artifact });
const fence = Schema.Struct({ owner: text, incarnation: natural, nonce: text });
export const readModelFence = Schema.decodeUnknownSync(fence);
const placement = Schema.Struct({
  version: Schema.Literal(1),
  operationId: text,
  owner: text,
  writer,
  lease: Schema.Struct({ token: text, loaderId: text, codeId: text, residentBytes: natural }),
  identity,
  input: Schema.Struct({
    runId: text,
    operationId: text,
    controllerClaim: control,
    facet: Schema.Struct({ processId: text }),
  }),
  termination: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("parent-destroyed"), observedByIncarnationNonce: text }),
      Schema.Struct({ kind: Schema.Literal("disposed"), facetNonce: text }),
    ]),
  ),
  released: Schema.optionalKey(Schema.Literal(true)),
  releaseWriter: Schema.optionalKey(writer),
});
const boundary = Schema.Struct({
  runId: text,
  phase: text,
  fence,
  control,
  process: Schema.Struct({ processId: text }),
  placement: Schema.Struct({ owner: text, executionOperationId: text, shardIndex: natural }),
  nativeSessionId: text,
  checkpoint,
  prepared: Schema.Struct({ identity }),
  requestPublisher: Schema.Struct({ generation: natural }),
  publication: Schema.optionalKey(Schema.Unknown),
});
const readPlacement = Schema.decodeUnknownSync(placement);
const readBoundary = Schema.decodeUnknownSync(boundary);

export async function readCreationRetirementEvidence(storage: DurableObjectStorage) {
  const placements = await storage.list<unknown>({
    prefix: "harness-process-creation-placement/v1/",
  });
  const journal = new HarnessProcessCreationJournal(storage);
  const observations = [];
  for (const [key, value] of placements) {
    const runId = decodeURIComponent(key.slice("harness-process-creation-placement/v1/".length));
    const record = await journal.read(runId);
    const source = await storage.get<unknown>(
      `harness-process-boundary/v1/${encodeURIComponent(runId)}`,
    );
    if (record?.binding && source !== undefined) {
      const { publication, ...decoded } = readBoundary(source);
      observations.push({
        key,
        placement: readPlacement(value),
        record: {
          phase: record.phase,
          claim: record.claim,
          binding: {
            identity: record.binding.identity,
            nativeSessionId: record.binding.nativeSessionId,
            checkpoint: record.binding.checkpoint,
          },
        },
        boundary: { ...decoded, published: publication !== undefined },
      });
    }
  }
  return observations;
}

export type CreationRetirementEvidence = Awaited<
  ReturnType<typeof readCreationRetirementEvidence>
>[number];

export function verifyCreationRetirement(input: {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly currentFence: ProcessFence;
  readonly history: readonly ProcessFence[];
  readonly creation: CreationRetirementEvidence;
  readonly completed: boolean;
  readonly writerReleased: boolean;
}) {
  const { owner, writer: currentWriter, currentFence, history, creation } = input;
  const { record, boundary: source } = creation;
  const saved = readPlacement(creation.placement);
  const binding = record.binding;
  const sourceWriter = {
    executionOperationId: source.placement.executionOperationId,
    shardIndex: source.placement.shardIndex,
    shardIncarnationNonce: source.fence.nonce,
    controllerClaim: source.control,
  };
  if (
    record.phase !== "bound" ||
    !binding ||
    source.phase !== "restoring" ||
    source.published !== false ||
    source.requestPublisher.generation !== 1 ||
    creation.key !== creationPlacementKey(source.runId) ||
    record.claim.runId !== source.runId ||
    record.claim.operationId !== saved.operationId ||
    record.claim.processId !== source.process.processId ||
    record.claim.ownerId !== owner ||
    record.claim.ownerIncarnationId !== source.fence.nonce ||
    saved.owner !== owner ||
    saved.input.runId !== source.runId ||
    saved.input.operationId !== saved.operationId ||
    saved.input.facet.processId !== source.process.processId ||
    source.placement.owner !== owner ||
    source.placement.executionOperationId !== saved.operationId ||
    !equals(saved.writer, sourceWriter) ||
    !equals(saved.input.controllerClaim, source.control) ||
    !equals(record.claim.controllerClaim, source.control) ||
    !equals(saved.identity, source.prepared.identity) ||
    !equals(saved.identity, binding.identity) ||
    saved.identity.shardOwner !== owner ||
    saved.identity.loaderId !== saved.identity.facetKey ||
    saved.lease.loaderId !== saved.identity.loaderId ||
    binding.nativeSessionId !== source.nativeSessionId ||
    !equals(binding.checkpoint, source.checkpoint) ||
    !equals(saved.termination, {
      kind: "parent-destroyed",
      observedByIncarnationNonce: currentFence.nonce,
    }) ||
    !equals(saved.releaseWriter, currentWriter) ||
    !equals(currentWriter, { ...sourceWriter, shardIncarnationNonce: currentFence.nonce }) ||
    source.fence.owner !== owner ||
    currentFence.owner !== owner ||
    currentFence.incarnation <= source.fence.incarnation ||
    currentFence.nonce === source.fence.nonce ||
    !history.some((row) => equals(row, source.fence)) ||
    !history.some((row) => equals(row, currentFence)) ||
    (input.completed && (saved.released !== true || input.writerReleased !== true))
  )
    throw new Error("Initial physical recovery lacks its exact durable creation retirement.");
  return {
    kind: "creation-parent-destroyed" as const,
    state: input.completed ? ("completed" as const) : ("release-ready" as const),
    owner,
    processId: source.process.processId,
    sourceFence: source.fence,
    currentFence,
    sourceWriter,
    currentWriter,
    identity: saved.identity,
    lease: saved.lease,
    nativeSessionId: binding.nativeSessionId,
    checkpoint: binding.checkpoint,
    creation,
    writerReleased: input.writerReleased,
  };
}
