// @effect-diagnostics nodeBuiltinImport:off - stale receiver writes are checked against real SQLite transactions.
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import { HarnessProcessIncarnation } from "../HarnessProcessIncarnation.ts";
import { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcTarget: Object,
}));

const runId = "incarnation-run";
const firstFence = { owner: "execution-shard", incarnation: 1, nonce: "first-nonce" };
const secondFence = { owner: "execution-shard", incarnation: 2, nonce: "second-nonce" };
const control1 = {
  ownerId: "process-owner",
  incarnationId: "controller-one",
  epoch: 1,
  controlKey: "controller-secret-one-".repeat(2),
};
const control2 = {
  ownerId: "process-owner",
  incarnationId: "controller-two",
  epoch: 2,
  controlKey: "controller-secret-two-".repeat(2),
};
const publisher1 = {
  generation: 1,
  facetNonce: "facet-one",
  publisherKey: "publisher-secret-one-".repeat(2),
};
const publisher2 = {
  generation: 2,
  facetNonce: "facet-two",
  publisherKey: "publisher-secret-two-".repeat(2),
};
const checkpoint = (checkpointId: string) => ({
  checkpointId,
  manifestSha256: checkpointId === "checkpoint-0" ? "a".repeat(64) : "b".repeat(64),
});

const contexts: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.close();
});

const context = (name: string) => {
  const fixture = durableRootContext(name);
  contexts.push(fixture);
  return fixture;
};
const asState = (value: ReturnType<typeof durableRootContext>["context"]) =>
  value as unknown as DurableObjectState;

describe("durable process incarnation fencing", () => {
  it("advances the local token on reconstruction and blocks the old shard's storage writes", async () => {
    const durable = context("local-shard");
    const storage = durable.storage as unknown as DurableObjectStorage;
    const oldShard = new HarnessProcessIncarnation(storage, "execution-shard", "first-nonce");
    const oldToken = await oldShard.ready;

    const currentShard = new HarnessProcessIncarnation(storage, "execution-shard", "second-nonce");
    const currentToken = await currentShard.ready;

    expect(oldToken).toEqual(firstFence);
    expect(currentToken).toEqual(secondFence);
    await expect(oldShard.assertCurrent()).rejects.toThrow(/fenced out/);

    const staleMutation = vi.fn();
    await expect(
      oldShard.transaction(async (transaction) => {
        staleMutation();
        await transaction.put("late-write", "must-not-land");
      }),
    ).rejects.toThrow(/fenced out/);
    await expect(oldShard.storage().put("late-put", "must-not-land")).rejects.toThrow(/fenced out/);
    expect(staleMutation).not.toHaveBeenCalled();
    expect(await storage.get("late-write")).toBeUndefined();
    expect(await storage.get("late-put")).toBeUndefined();

    await currentShard.storage().put("current-write", "accepted");
    expect(await storage.get("current-write")).toBe("accepted");
  });

  it("rejects stale RunStore commands and monotonic fence claims", async () => {
    const durable = context(runId);
    const store = new HarnessRunStoreObject(asState(durable.context), {});
    await store.claimProcessFence(firstFence);
    await store.execute(
      {
        type: "initialize",
        seed: {
          identity: {
            runId,
            hostId: "host",
            threadId: "thread",
            logicalTurnId: "turn",
            filesystemId: "files",
          },
          locator: { id: "facet", sha256: "c".repeat(64), bytes: 1 },
          config: { id: "config", sha256: "d".repeat(64), bytes: 1 },
          artifacts: [{ id: "runtime", sha256: "e".repeat(64), bytes: 1 }],
        },
        controlKey: control1.controlKey,
        supervisorKey: "supervisor-secret-".repeat(2),
        claimId: "owner-one",
        requestId: "initialize-one",
      },
      firstFence,
    );
    await store.claimProcessFence(secondFence);

    const intent = {
      type: "intent",
      runId,
      supervisor: { epoch: 1, claimId: "owner-one", supervisorKey: "supervisor-secret-".repeat(2) },
      intent: {
        intentId: "late-intent",
        kind: "test-command",
        reference: { id: "input", sha256: "a".repeat(64), bytes: 1 },
      },
    };
    const before = await store.execute({ type: "read", runId }, secondFence);
    await expect(store.execute(intent, firstFence)).rejects.toThrow();
    await expect(store.execute(intent)).rejects.toThrow();
    expect(await store.execute({ type: "read", runId }, secondFence)).toEqual(before);
    await store.execute(intent, secondFence);
    expect(() => store.claimProcessFence(firstFence)).toThrow(/stale process-shard incarnation/);
    expect(() => store.claimProcessFence({ ...secondFence, nonce: "same-counter-fork" })).toThrow(
      /stale process-shard incarnation/,
    );

    const current = await store.execute({ type: "read", runId }, secondFence);
    expect(current.snapshot.seed.identity.runId).toBe(runId);
  });

  it("blocks an old checkpoint commit and facet publication at the receiver", async () => {
    const durable = context(runId);
    const supervisor = new HarnessThreadSupervisorObject(asState(durable.context), {});
    await supervisor.claimProcessFence(firstFence);
    await supervisor.execute(
      {
        type: "initialize",
        runId,
        nativeSessionId: "native-session",
        control: control1,
        publisher: publisher1,
        checkpoint: checkpoint("checkpoint-0"),
      },
      firstFence,
    );
    await supervisor.execute(
      {
        type: "admitStep",
        runId,
        publisher: publisher1,
        stepId: "step-one",
        expectedCheckpointId: "checkpoint-0",
      },
      firstFence,
    );
    await supervisor.execute(
      {
        type: "commitCheckpoint",
        runId,
        publisher: publisher1,
        stepId: "step-one",
        expectedCheckpointId: "checkpoint-0",
        checkpoint: checkpoint("checkpoint-1"),
      },
      firstFence,
    );
    await supervisor.execute(
      {
        type: "admitStep",
        runId,
        publisher: publisher1,
        stepId: "step-two",
        expectedCheckpointId: "checkpoint-1",
      },
      firstFence,
    );
    await supervisor.claimProcessFence(secondFence);

    const lateCommit = {
      type: "commitCheckpoint" as const,
      runId,
      publisher: publisher1,
      stepId: "step-two",
      expectedCheckpointId: "checkpoint-1",
      checkpoint: checkpoint("checkpoint-2"),
    };
    await expect(supervisor.execute(lateCommit, firstFence)).rejects.toThrow();
    await expect(supervisor.execute(lateCommit)).rejects.toThrow();
    expect(
      await supervisor.execute({ type: "read", runId, control: control1 }, secondFence),
    ).toMatchObject({
      snapshot: {
        admittedStepId: "step-two",
        checkpoint: checkpoint("checkpoint-1"),
      },
    });
    await supervisor.execute(lateCommit, secondFence);

    const transitionId = "resume-transition";
    await supervisor.execute(
      {
        type: "beginDrain",
        runId,
        control: control1,
        publisher: publisher1,
        expectedGeneration: 1,
        operationId: transitionId,
        nextControl: control2,
      },
      secondFence,
    );
    await supervisor.execute(
      {
        type: "confirmControlSync",
        runId,
        control: control2,
        fromEpoch: control1.epoch,
        fromIncarnationId: control1.incarnationId,
        expectedGeneration: 1,
        operationId: transitionId,
        publication: null,
        preparedPublication: null,
      },
      secondFence,
    );
    await supervisor.execute(
      {
        type: "recordStopAcknowledgement",
        runId,
        control: control2,
        publisher: publisher1,
        expectedGeneration: 1,
        requestId: "step-two",
        acknowledgementId: "stop-ack",
      },
      secondFence,
    );
    await supervisor.execute(
      {
        type: "settleInvocation",
        runId,
        control: control2,
        publisher: publisher1,
        expectedGeneration: 1,
        outcome: "stopped",
        invocationRpcJoined: true,
        fetchJoined: true,
        callbackPortsJoined: true,
      },
      secondFence,
    );
    await supervisor.execute(
      {
        type: "prepareFreshFacet",
        runId,
        control: control2,
        publisher: publisher1,
        expectedGeneration: 1,
        operationId: transitionId,
        preparedPublisher: publisher2,
      },
      secondFence,
    );

    const latePublication = {
      type: "publishFreshFacet" as const,
      runId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: transitionId,
      preparedPublisher: publisher2,
      verifiedNativeSessionId: "native-session",
      checkpoint: checkpoint("checkpoint-2"),
    };
    await expect(supervisor.execute(latePublication, firstFence)).rejects.toThrow();
    expect(
      await supervisor.execute({ type: "read", runId, control: control2 }, secondFence),
    ).toMatchObject({ snapshot: { lifecycle: "preparing" }, currentPublisher: publisher1 });
    await supervisor.execute(latePublication, secondFence);
    expect(
      await supervisor.execute({ type: "read", runId, control: control2 }, secondFence),
    ).toMatchObject({ snapshot: { lifecycle: "published" }, currentPublisher: publisher2 });
  });

  it.each(["readCheckpoint", "recoverCheckpoint"] as const)(
    "fences legacy schema migration during %s at the FilesStore receiver",
    async (type) => {
      const durable = context(runId);
      const files = new HarnessFilesStoreObject(asState(durable.context), {});
      const original = await files.execute({
        type: "initialize",
        runId,
        control: control1,
        publisher: publisher1,
        checkpoint: {
          checkpointId: "checkpoint-0",
          parentCheckpointId: null,
          files: [{ path: "state.txt", mode: 0o644, bytes: new TextEncoder().encode("legacy") }],
        },
      });
      durable.storage.sql.exec("ALTER TABLE harness_files_entry DROP COLUMN kind");
      await files.claimProcessFence(firstFence);
      await files.claimProcessFence(secondFence);
      const schema = durable.rows("SELECT name, sql FROM sqlite_master ORDER BY name");
      const command = { type, runId, publisher: publisher1, checkpointId: "checkpoint-0" };

      await expect(files.execute(command)).rejects.toThrow();
      await expect(files.execute(command, firstFence)).rejects.toThrow();
      expect(durable.rows("SELECT name, sql FROM sqlite_master ORDER BY name")).toEqual(schema);

      const migrated = await files.execute(command, secondFence);
      expect(migrated.checkpoint).toEqual(original.checkpoint);
      expect(migrated.files).toEqual([
        { path: "state.txt", mode: 0o644, bytes: new TextEncoder().encode("legacy") },
      ]);
      expect(durable.rows("SELECT kind FROM harness_files_entry")).toEqual([{ kind: "file" }]);
      expect(await files.execute(command)).toEqual(migrated);
    },
  );

  it("rechecks the FilesStore write boundary after asynchronous checkpoint hashing", async () => {
    const durable = context(runId);
    const files = new HarnessFilesStoreObject(asState(durable.context), {});
    await files.claimProcessFence(firstFence);
    const initialized = await files.execute(
      {
        type: "initialize",
        runId,
        control: control1,
        publisher: publisher1,
        checkpoint: {
          checkpointId: "checkpoint-0",
          parentCheckpointId: null,
          files: [{ path: "state.txt", mode: 0o644, bytes: new TextEncoder().encode("initial") }],
        },
      },
      firstFence,
    );
    await files.execute(
      {
        type: "admitStep",
        runId,
        publisher: publisher1,
        stepId: "step-one",
        expectedCheckpointId: "checkpoint-0",
      },
      firstFence,
    );

    const hashing = Promise.withResolvers<void>();
    const releaseHash = Promise.withResolvers<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let held = false;
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) => {
      if (!held) {
        held = true;
        hashing.resolve();
        return releaseHash.promise.then(() => digest(algorithm, bytes));
      }
      return digest(algorithm, bytes);
    });

    const write = files.execute(
      {
        type: "writeCheckpoint",
        runId,
        publisher: publisher1,
        stepId: "step-one",
        expectedCheckpointId: "checkpoint-0",
        checkpoint: {
          checkpointId: "checkpoint-1",
          parentCheckpointId: "checkpoint-0",
          files: [{ path: "state.txt", mode: 0o644, bytes: new TextEncoder().encode("late") }],
        },
      },
      firstFence,
    );
    await hashing.promise;
    await files.claimProcessFence(secondFence);
    expect(() => files.claimProcessFence(firstFence)).toThrow(/stale process-shard incarnation/);
    expect(() => files.claimProcessFence({ ...secondFence, nonce: "same-counter-fork" })).toThrow(
      /stale process-shard incarnation/,
    );
    releaseHash.resolve();

    await expect(write).rejects.toThrow();
    expect(
      durable.rows("SELECT checkpoint_id FROM harness_files_checkpoint ORDER BY checkpoint_id"),
    ).toEqual([{ checkpoint_id: "checkpoint-0" }]);
    expect(
      await files.execute(
        { type: "readCheckpoint", runId, publisher: publisher1, checkpointId: "checkpoint-0" },
        secondFence,
      ),
    ).toMatchObject({
      checkpoint: {
        checkpointId: initialized.checkpoint.checkpointId,
        manifestSha256: initialized.checkpoint.manifestSha256,
      },
    });
  });
});
