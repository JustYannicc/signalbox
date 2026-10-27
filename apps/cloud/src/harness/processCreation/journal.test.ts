import { describe, expect, it } from "vite-plus/test";
import { prepareHarnessFilesCheckpoint as prepareCheckpoint } from "../HarnessFilesStore.ts";
import type { HarnessDurableStateInitializationInput } from "../HarnessDurableState.ts";
import type { HarnessProcessPlacementIdentity } from "../HarnessProcessPlacement.ts";
import {
  HarnessProcessCreationJournal,
  type HarnessProcessCreationBinding,
  type HarnessProcessCreationClaim,
} from "../HarnessProcessCreation.ts";

const nativeSessionId = "019b4d15-40e8-7abc-8def-0123456789ab";
const nextNativeSessionId = "019b4d15-40e8-7abc-8def-1123456789ab";
const copy = <Value>(value: Value): Value => structuredClone(value);

function reverseObjectKeys<Value>(value: Value): Value {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value === null) return value;
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as Value;
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  ) as Value;
}

function createStorage(): ConstructorParameters<typeof HarnessProcessCreationJournal>[0] {
  const values = new Map<string, unknown>();
  let pending = Promise.resolve();

  const storage = {
    get: async <Value>(key: string): Promise<Value | undefined> =>
      copy(values.get(key) as Value | undefined),
    transaction: async <Value>(
      callback: (transaction: DurableObjectTransaction) => Promise<Value>,
    ): Promise<Value> => {
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = new Map<string, unknown>(
        [...values].map(([key, value]) => [key, copy(value)] as const),
      );
      const transaction = {
        get: async <Stored>(key: string): Promise<Stored | undefined> =>
          copy(values.get(key) as Stored | undefined),
        put: async (key: string, value: unknown): Promise<void> => {
          values.set(key, copy(value));
        },
      } as DurableObjectTransaction;
      try {
        return await callback(transaction);
      } catch (error) {
        values.clear();
        for (const [key, value] of before) values.set(key, value);
        throw error;
      } finally {
        release();
      }
    },
  };
  return storage;
}

function creationClaim(runId = "run-1"): HarnessProcessCreationClaim {
  return {
    runId,
    operationId: "operation-1",
    processId: "process-1",
    ownerId: "owner-1",
    ownerIncarnationId: "owner-incarnation-1",
    controllerClaim: {
      ownerId: "controller-owner-1",
      incarnationId: "controller-incarnation-1",
      epoch: 1,
      controlKey: "controller-control-key-00000000000000000000000000000000",
    },
    descriptorSha256: "a".repeat(64),
  };
}

async function creationBinding(
  claim: HarnessProcessCreationClaim,
  sessionId = nativeSessionId,
): Promise<HarnessProcessCreationBinding> {
  const identity: HarnessProcessPlacementIdentity = {
    shardOwner: claim.ownerId,
    loaderId: "loader-1",
    facetKey: "loader-1",
    incarnationNonce: "facet-incarnation-1",
  };
  const checkpoint = {
    checkpointId: "checkpoint-1",
    parentCheckpointId: null,
    files: [
      {
        path: "src/created.ts",
        mode: 0o644,
        bytes: new TextEncoder().encode("export const created = true;\n"),
      },
    ],
  };
  const prepared = await prepareCheckpoint(checkpoint);
  const initialization: HarnessDurableStateInitializationInput = {
    run: {
      type: "initialize",
      seed: {
        identity: {
          runId: claim.runId,
          hostId: "host-1",
          threadId: "thread-1",
          logicalTurnId: "turn-1",
          filesystemId: "filesystem-1",
        },
        locator: { id: "locator-1", sha256: "b".repeat(64), bytes: 1 },
        config: { id: "config-1", sha256: "c".repeat(64), bytes: 1 },
        artifacts: [],
      },
      controlKey: "run-control-key-00000000000000000000000000000000",
      supervisorKey: "run-supervisor-key-00000000000000000000000000000000",
      claimId: "run-claim-1",
      requestId: "run-request-1",
    },
    nativeSessionId: sessionId,
    control: { ...claim.controllerClaim },
    publisher: {
      generation: 1,
      facetNonce: identity.incarnationNonce,
      publisherKey: "publisher-key-00000000000000000000000000000000",
    },
    checkpoint,
  };
  return {
    nativeSessionId: sessionId,
    identity,
    checkpoint: {
      native: { id: checkpoint.checkpointId, sha256: "d".repeat(64), bytes: 256 },
      filesystem: {
        id: checkpoint.checkpointId,
        sha256: prepared.manifestSha256,
        bytes: prepared.byteCount,
      },
    },
    initialization,
  };
}

describe("HarnessProcessCreationJournal", () => {
  it("claims one operation per run and returns duplicate or competing claims unchanged", async () => {
    const storage = createStorage();
    const journal = new HarnessProcessCreationJournal(storage);
    const claim = creationClaim();
    const first = await journal.claim(claim);
    const duplicate = await journal.claim(claim);
    const otherOperationClaim = { ...claim, operationId: "operation-2" };
    const otherIncarnationClaim = { ...claim, ownerIncarnationId: "owner-incarnation-2" };
    const [otherOperation, otherIncarnation] = await Promise.all([
      journal.claim(otherOperationClaim),
      journal.claim(otherIncarnationClaim),
    ]);

    expect(first.status).toBe("claimed");
    expect(duplicate).toEqual({ status: "existing", record: first.record });
    expect(otherOperation).toEqual({ status: "existing", record: first.record });
    expect(otherIncarnation).toEqual({ status: "existing", record: first.record });

    const binding = await creationBinding(claim);
    await expect(journal.stage(otherOperationClaim, binding)).rejects.toThrow();
    await expect(journal.bind(otherIncarnationClaim)).rejects.toThrow();
    expect(await journal.read(claim.runId)).toEqual(first.record);
  });

  it("refuses stale stage and bind calls after journal reconstruction", async () => {
    const storage = createStorage();
    const original = new HarnessProcessCreationJournal(storage);
    const claim = creationClaim();
    await original.claim(claim);

    const reconstructed = new HarnessProcessCreationJournal(storage);
    const stale = { ...claim, ownerIncarnationId: "owner-incarnation-recreated" };
    await expect(reconstructed.stage(stale, await creationBinding(claim))).rejects.toThrow();
    await expect(reconstructed.bind(stale)).rejects.toThrow();
    expect((await reconstructed.read(claim.runId))?.phase).toBe("claimed");
    await expect(reconstructed.bind(claim)).rejects.toThrow();
  });

  it("keeps the first staged binding immutable and makes binding idempotent", async () => {
    const journal = new HarnessProcessCreationJournal(createStorage());
    const claim = creationClaim();
    await journal.claim(claim);
    const binding = await creationBinding(claim);
    const staged = await journal.stage(claim, binding);
    binding.initialization.checkpoint.files[0]!.bytes[0] = 0;

    const reordered = reverseObjectKeys(await creationBinding(claim));
    const replay = await journal.stage(claim, reordered);
    expect(replay).toEqual(staged);
    const different = await creationBinding(claim, nextNativeSessionId);
    await expect(journal.stage(claim, different)).rejects.toThrow();

    const bound = await journal.bind(claim);
    expect(bound.phase).toBe("bound");
    expect(await journal.bind(claim)).toEqual(bound);
    await expect(journal.stage(claim, different)).rejects.toThrow();
  });

  it("rejects malformed UUIDs, mismatched initialization, and inconsistent checkpoint references", async () => {
    const journal = new HarnessProcessCreationJournal(createStorage());
    const claim = creationClaim();
    await journal.claim(claim);

    const malformed = await creationBinding(claim, "native-session");
    await expect(journal.stage(claim, malformed)).rejects.toThrow();

    const mismatchedInitialization = await creationBinding(claim);
    (mismatchedInitialization.initialization as { nativeSessionId: string }).nativeSessionId =
      nextNativeSessionId;
    await expect(journal.stage(claim, mismatchedInitialization)).rejects.toThrow();

    const mismatchedRun = await creationBinding(claim);
    (mismatchedRun.initialization.run.seed.identity as { runId: string }).runId = "another-run";
    await expect(journal.stage(claim, mismatchedRun)).rejects.toThrow();

    const wrongPublisherGeneration = await creationBinding(claim);
    (wrongPublisherGeneration.initialization.publisher as { generation: number }).generation = 2;
    await expect(journal.stage(claim, wrongPublisherGeneration)).rejects.toThrow();

    const wrongFacetIdentity = await creationBinding(claim);
    (wrongFacetIdentity.identity as { incarnationNonce: string }).incarnationNonce =
      "another-incarnation";
    await expect(journal.stage(claim, wrongFacetIdentity)).rejects.toThrow();

    const mismatchedCheckpoint = await creationBinding(claim);
    (mismatchedCheckpoint.checkpoint.filesystem as { sha256: string }).sha256 = "e".repeat(64);
    await expect(journal.stage(claim, mismatchedCheckpoint)).rejects.toThrow();
    expect((await journal.read(claim.runId))?.phase).toBe("claimed");
  });

  it("reads back the exact bound candidate from reconstructed storage", async () => {
    const storage = createStorage();
    const journal = new HarnessProcessCreationJournal(storage);
    const claim = creationClaim();
    const binding = await creationBinding(claim);
    await journal.claim(claim);
    await journal.stage(claim, binding);
    const bound = await journal.bind(claim);

    expect(bound).toEqual({ phase: "bound", claim, binding });
    expect(await new HarnessProcessCreationJournal(storage).read(claim.runId)).toEqual(bound);
  });
});

it("rejects corrupt persisted bindings before reading nested authority or checkpoint fields", async () => {
  const storage = createStorage();
  const claim = creationClaim();
  const binding = await creationBinding(claim);
  const corruptions = [
    { phase: "bound", claim, binding: {} },
    { phase: "staged", claim, binding: { ...binding, checkpoint: null } },
    {
      phase: "bound",
      claim,
      binding: { ...binding, initialization: { ...binding.initialization, run: {} } },
    },
    {
      phase: "bound",
      claim,
      binding: { ...binding, identity: { ...binding.identity, loaderId: 7 } },
    },
    { phase: "claimed", claim, binding },
  ];
  for (const record of corruptions) {
    await storage.transaction((transaction) =>
      transaction.put(`harness-process-creation-v1/${claim.runId}`, record),
    );
    await expect(new HarnessProcessCreationJournal(storage).read(claim.runId)).rejects.toThrow(
      "journal record is corrupt",
    );
  }
});
