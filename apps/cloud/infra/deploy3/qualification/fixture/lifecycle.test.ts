import { expect, it } from "vite-plus/test";
import { Lifecycle } from "./lifecycle.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";

function lifecycleFixture(failCreation: boolean) {
  let results = 0;
  let stubs = 0;
  const stored = new Map<string, unknown>();
  const pendingRun = Promise.withResolvers<unknown>();
  const identity = { incarnationNonce: "physical-facet-1", loaderId: "physical-loader-1" };
  const checkpoint = { native: { id: "native-checkpoint-1" } };
  const nativeSessionId = "00000000-0000-4000-8000-000000000001";
  const result = <A extends object>(value: A): A => {
    results++;
    Object.defineProperty(value, Symbol.dispose, { value: () => results-- });
    return value;
  };
  const namespace = <A extends object>(methods: A) => ({
    getByName() {
      stubs++;
      return {
        ...methods,
        [Symbol.dispose]() {
          stubs--;
        },
      };
    },
  });
  const shards = namespace({
    async startFreshProcess() {
      if (failCreation) throw new Error("cold creation failed");
      return result({ status: "created", nativeSessionId, identity, checkpoint });
    },
    async processCreationStatus() {
      return result({ status: "bound", nativeSessionId });
    },
    async runCreatedProcess() {
      return await pendingRun.promise;
    },
    async commitProcessCheckpoint() {
      pendingRun.resolve(result({ processes: [{ status: "settled", identity }] }));
      return result({ status: "committed" });
    },
    async evidence() {
      return result({ executed: true });
    },
  });
  const runStore = namespace({
    async execute() {
      return result({ snapshot: { requests: { entries: [] } } });
    },
    async waitForFinish() {
      return result({
        snapshot: {
          requests: {
            entries: [
              {
                request: { requestId: "turn-1" },
                status: "completed",
                finish: { status: "completed", checkpoint },
              },
            ],
          },
        },
      });
    },
  });
  const supervisor = namespace({
    async execute() {
      return result({
        snapshot: { nativeSessionId },
        currentPublisher: { facetNonce: identity.incarnationNonce },
      });
    },
  });
  const owner = {
    config: async () => ({
      runId: "00000000-0000-4000-8000-000000000002",
      workerName: "sb1070-d3-00000000-1793556000-workload",
      turnJson: [JSON.stringify({ providerThread: {} })],
      expectedRelease: {
        artifact: { releaseId: "codex-rpc-release", artifactRef: `sha256:${"a".repeat(64)}` },
        plan: {
          preparedModules: {
            "codex/engine.wasm": {
              type: "wasm",
              path: "codex/engine.wasm",
              bytes: 8,
              sha256: "b".repeat(64),
            },
          },
        },
      },
    }),
    environment: () => ({ HARNESS_RUN_STORE: runStore, HARNESS_THREAD_SUPERVISOR: supervisor }),
    shard: () => shards.getByName(),
    artifact: async () => ({ id: "seed", bytes: 0, sha256: "c".repeat(64) }),
    append: async () => ({ sequence: 1 }),
    material: async () => ({ checkpointId: "files-checkpoint-1" }),
    recordActiveCheckpoint: async () => {},
    saveState: async (key: string, value: unknown) => {
      stored.set(key, value);
    },
    model: {
      bind() {},
      begin() {},
      current: () => ({ incarnation: identity.incarnationNonce, loaderId: identity.loaderId }),
      complete: async () => {},
      peer: { failure: new Promise<never>(() => {}) },
    },
  } as unknown as QualifierExecutionContext;
  return { lifecycle: new Lifecycle(owner), outstanding: () => ({ results, stubs }), stored };
}

it("detaches Codex lifecycle records and releases shard/store results through an actual turn", async () => {
  const fixture = lifecycleFixture(false);
  const receipt = await fixture.lifecycle.turn(1);
  expect(receipt.executed.processes[0]?.status).toBe("settled");
  expect(fixture.lifecycle.currentCheckpoint().native.id).toBe("native-checkpoint-1");
  expect(fixture.outstanding()).toEqual({ results: 0, stubs: 0 });
  expect(Object.getOwnPropertySymbols(receipt.executed)).toEqual([]);
  expect(fixture.stored.has("created")).toBe(true);
  expect(fixture.stored.has("turn-1")).toBe(true);
});

it("releases the Codex shard lookup when cold creation fails", async () => {
  const fixture = lifecycleFixture(true);
  await expect(fixture.lifecycle.cold()).rejects.toThrow("cold creation failed");
  expect(fixture.outstanding()).toEqual({ results: 0, stubs: 0 });
});
