import { describe, expect, it, vi } from "vite-plus/test";
import { verifyCreationRetirement } from "./modelCreationRetirement.fixture.ts";
import {
  collectModelPhysicalRecovery,
  verifyModelPhysicalRecovery,
} from "./modelPhysicalRecovery.fixture.ts";
import { ObservedPlacementStore } from "./placementReleaseObserver.fixture.ts";
import { retirement } from "./placementReleaseData.fixture.ts";
import { durableRootContext } from "../../tests/processIncarnation/durableRootFixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

function creation() {
  const previous = retirement();
  const { receipt, owner, writer, evidence } = previous;
  const checkpoint = {
    native: { id: "initial-native", sha256: "native-digest", bytes: 10 },
    filesystem: { id: "initial-native", sha256: "files-digest", bytes: 20 },
  };
  const identity = { ...receipt.identity };
  const input = {
    owner,
    writer,
    currentFence: receipt.currentFence,
    history: [receipt.sourceFence, receipt.currentFence],
    completed: true,
    writerReleased: true,
    creation: {
      key: "harness-process-creation-placement/v1/run",
      placement: {
        version: 1 as const,
        owner,
        operationId: receipt.sourceWriter.executionOperationId,
        writer: { ...receipt.sourceWriter },
        lease: { ...receipt.lease },
        identity,
        input: {
          runId: "run",
          operationId: receipt.sourceWriter.executionOperationId,
          controllerClaim: receipt.sourceWriter.controllerClaim,
          facet: { processId: receipt.processId },
        },
        released: true as const,
        releaseWriter: { ...writer },
        termination: {
          kind: "parent-destroyed" as const,
          observedByIncarnationNonce: receipt.currentFence.nonce,
        },
      },
      record: {
        phase: "bound" as const,
        claim: {
          runId: "run",
          operationId: receipt.sourceWriter.executionOperationId,
          processId: receipt.processId,
          ownerId: owner,
          ownerIncarnationId: receipt.sourceFence.nonce,
          controllerClaim: receipt.sourceWriter.controllerClaim,
          descriptorSha256: "a".repeat(64),
        },
        binding: { nativeSessionId: "019b4d15-40e8-7abc-8def-0123456789ab", identity, checkpoint },
      },
      boundary: {
        runId: "run",
        phase: "restoring",
        published: false,
        fence: { ...receipt.sourceFence },
        control: receipt.sourceWriter.controllerClaim,
        process: { processId: receipt.processId },
        placement: {
          owner,
          executionOperationId: receipt.sourceWriter.executionOperationId,
          shardIndex: 0,
        },
        nativeSessionId: "019b4d15-40e8-7abc-8def-0123456789ab",
        checkpoint,
        prepared: { identity },
        requestPublisher: { generation: 1 },
      },
    },
  };
  return { input, evidence, previous };
}

describe("initial physical retirement", () => {
  it("requires both the completed C creation release and the exact A writer receipt", () => {
    const { input } = creation();
    expect(verifyCreationRetirement(input).state).toBe("completed");
    expect(() => verifyCreationRetirement({ ...input, writerReleased: false })).toThrow();
    const { released: _released, ...pending } = input.creation.placement;
    expect(() =>
      verifyCreationRetirement({ ...input, creation: { ...input.creation, placement: pending } }),
    ).toThrow();
    expect(
      verifyCreationRetirement({
        ...input,
        completed: false,
        creation: { ...input.creation, placement: pending },
      }).state,
    ).toBe("release-ready");
  });

  it.each([
    [
      "creation key",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.key = "another-key";
      },
    ],
    [
      "UUID",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.record.binding.nativeSessionId = "another-session";
      },
    ],
    [
      "checkpoint",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.record.binding.checkpoint = {
          ...value.input.creation.record.binding.checkpoint,
          native: { id: "other", sha256: "other", bytes: 1 },
        };
      },
    ],
    [
      "source fence",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.boundary.fence.nonce = "forged";
      },
    ],
    [
      "source writer",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.placement.writer.shardIncarnationNonce = "forged";
      },
    ],
    [
      "release writer",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.placement.releaseWriter.executionOperationId = "forged";
      },
    ],
    [
      "parent destruction",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.placement.termination.observedByIncarnationNonce = "forged";
      },
    ],
    [
      "physical identity",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.placement.identity = {
          ...value.input.creation.placement.identity,
          loaderId: "another-loader",
        };
      },
    ],
    [
      "creation claim",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.record.claim.ownerIncarnationId = "forged";
      },
    ],
    [
      "logical generation",
      (value: ReturnType<typeof creation>) => {
        value.input.creation.boundary.requestPublisher.generation = 2;
      },
    ],
    [
      "history",
      (value: ReturnType<typeof creation>) => {
        value.input.history = [value.input.currentFence];
      },
    ],
  ])("rejects forged %s", (_name, mutate) => {
    const value = creation();
    mutate(value);
    expect(() => verifyCreationRetirement(value.input)).toThrow();
  });

  it("collects the creation path through the actual public writer-release query", async () => {
    const { input } = creation();
    const made = input.creation;
    const target = { incarnation: "new-facet", loaderId: "new-loader" };
    const boundary = {
      runId: made.boundary.runId,
      processId: made.boundary.process.processId,
      nativeSessionId: made.boundary.nativeSessionId,
      checkpoint: made.boundary.checkpoint,
      phase: made.boundary.phase,
      fence: made.boundary.fence,
      writer: made.placement.writer,
      identity: made.placement.identity,
      generation: 1,
    };
    const record = {
      version: 1 as const,
      shardOwner: input.owner,
      controllerClaim: input.writer.controllerClaim,
      operationId: `eviction-restore-${input.currentFence.incarnation}-${input.currentFence.nonce}`,
      processId: boundary.processId,
      nativeSessionId: boundary.nativeSessionId,
      checkpointId: boundary.checkpoint.native.id,
      manifestRevision: boundary.checkpoint.filesystem.sha256,
      priorFacetNonce: boundary.identity.incarnationNonce,
      expectedFacetGeneration: 1,
      programCodeId: "new-code",
      ...target,
      incarnationNonce: target.incarnation,
      facetKey: target.loaderId,
      identityState: "observed" as const,
      state: "preparing" as const,
      lease: { ...made.placement.lease, loaderId: target.loaderId },
      stopAcknowledged: false,
      joined: { invocationRpc: false, fetch: false, ports: false },
    };
    const source = {
      boundary,
      currentFence: input.currentFence,
      history: input.history,
      creation: made,
    };
    let queries = 0;
    let released = false;
    const placement = {
      readWriter: async () => input.writer,
      listRecovery: async () => [record],
      readEvictedRecovery: async () => undefined,
      writerReleased: async (owner: string, writer: typeof input.writer) => {
        expect(owner).toBe(input.owner);
        expect(writer).toEqual(input.writer);
        queries++;
        return released;
      },
    };
    for (const override of [
      { readWriter: async () => undefined },
      { listRecovery: async () => [] },
      { listRecovery: async () => [record, record] },
    ])
      await expect(
        collectModelPhysicalRecovery(input.owner, target, source, { ...placement, ...override }),
      ).rejects.toThrow();
    await expect(
      collectModelPhysicalRecovery(input.owner, target, source, placement),
    ).rejects.toThrow();
    released = true;
    const collected = await collectModelPhysicalRecovery(input.owner, target, source, placement);
    expect(queries).toBe(2);
    expect(collected).toBeDefined();
    if (!collected) throw new Error("No collected creation retirement");
    const proof = verifyModelPhysicalRecovery(
      {
        owner: input.owner,
        runId: "run",
        processId: boundary.processId,
        nativeSessionId: boundary.nativeSessionId,
        checkpoint: boundary.checkpoint,
        controllerClaim: input.writer.controllerClaim,
        from: {
          incarnation: boundary.identity.incarnationNonce,
          loaderId: boundary.identity.loaderId,
        },
        to: target,
      },
      collected,
    );
    expect(proof.retirement.state).toBe("completed");
  });

  it("observes actual placement release without claiming a native request stopped or joined", async () => {
    const { input, evidence, previous } = creation();
    const durable = durableRootContext(input.owner);
    const store = new ObservedPlacementStore(
      durable.context as unknown as DurableObjectState,
      {
        PROCESS_EXECUTION_SHARDS: {
          getByName: () => ({
            executionIncarnationNonce: async () => input.currentFence.nonce,
            placementReleaseEvidence: async () => ({ ...evidence, creations: [input.creation] }),
          }),
        },
      } as unknown as ConstructorParameters<typeof ObservedPlacementStore>[1],
    );
    try {
      await store.claimProcessFence(input.currentFence);
      await store.claimWriter(input.owner, input.writer);
      await durable.storage.put("harness-process-slots-v1", previous.slots);
      await store.releaseWriter(input.owner, input.writer);
      expect(await store.writerReleased(input.owner, input.writer)).toBe(true);
      expect(await store.readWriter(input.owner)).toBeUndefined();
      expect(await durable.storage.list({ prefix: "harness-process-terminal/" })).toEqual(
        new Map(),
      );
    } finally {
      durable.close();
    }
  });
});
