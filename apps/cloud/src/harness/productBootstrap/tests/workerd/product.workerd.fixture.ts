import { ProductFixtureFilesStore as HarnessFilesStoreObject } from "./productStores.workerd.fixture.ts";
import { ProductFixtureRunStore } from "./productStores.workerd.fixture.ts";
import { HarnessThreadSupervisorObject } from "../../../HarnessThreadSupervisorObject.ts";
import { HarnessProcessExecutionShardObject } from "../../../HarnessProcessExecutionShardObject.ts";
import { HarnessProcessPlacementStoreObject } from "../../../HarnessProcessPlacementStoreObject.ts";
import type { HarnessProcessExecutionHooks } from "../../../processPlacement/executionLifecycle.ts";
import type { HarnessProcessExecutionShardInput } from "../../../processPlacement/execution.ts";
import type { ProductWorkerEnv } from "./productBindings.workerd.fixture.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../HarnessCProductCapabilities.ts";
import { serializeHarnessRequestFacetFailure } from "./memoryFailure.workerd.fixture.ts";
import { ProductFixtureCapability } from "./productCapability.workerd.fixture.ts";
import type { ProductFixtureMemoryProofFailure } from "./productCapability.workerd.fixture.ts";
import { ProductFixtureExecutor } from "./productExecutor.workerd.fixture.ts";
import { ProductHeapProbe } from "./productHeapProbe.workerd.fixture.ts";
import { setupProductRun } from "./productScenarioSetup.workerd.fixture.ts";
import { runProductScenario } from "./productScenario.workerd.fixture.ts";
import {
  readR18Inputs,
  legacyModuleMap,
  copyLegacyModuleSnapshot,
  memoryModuleInventory,
  type MemoryModuleInventory,
} from "./memoryModules.workerd.fixture.ts";
import { memoryNativeModule } from "./memoryNative.workerd.fixture.ts";

export {
  HarnessFilesStoreObject,
  ProductFixtureRunStore,
  HarnessThreadSupervisorObject,
  ProductFixtureCapability,
  ProductFixtureExecutor,
};

export class ProductFixtureShard extends HarnessProcessExecutionShardObject {
  #heapProbe = new ProductHeapProbe();
  #memoryProofRunId: string | undefined;
  #legacyModuleSet: ReturnType<typeof copyLegacyModuleSnapshot> | undefined;
  #memoryModuleInventory: MemoryModuleInventory = [];
  #ctx: DurableObjectState;
  #env: ProductWorkerEnv;

  constructor(ctx: DurableObjectState, env: ProductWorkerEnv) {
    const name = "product-fixture";
    const capabilities = env.PRODUCT_FIXTURE.getByName(name) as unknown as Fetcher;
    const executor = env.PRODUCT_EXECUTOR.getByName(name) as unknown as Fetcher;
    super(ctx, {
      ...env,
      HARNESS_C_PRODUCT_CAPABILITIES: {
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.access]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor]: executor,
      },
    });
    this.#ctx = ctx;
    this.#env = env;
  }

  holdHeapProbe(bytes: number) {
    return this.#heapProbe.hold(bytes);
  }

  releaseHeapProbe() {
    return this.#heapProbe.release();
  }

  async memoryProofPhase(runId: string) {
    const phase = await this.#ctx.storage.get<{ readonly runId: string; readonly phase: string }>(
      `fixture/memory-proof-phase/${runId}`,
    );
    return {
      phase: phase?.runId === runId ? phase.phase : "not-started",
      shardObjectName: this.#ctx.id.name ?? null,
    } as const;
  }

  async memoryProofCompletion(runId: string) {
    return await this.#ctx.storage.get<{
      readonly runId: string;
      readonly processes: readonly {
        readonly processId: string;
        readonly status: string;
        readonly recoveryId?: string;
        readonly error?: {
          readonly kind: string;
          readonly message: string;
          readonly facetFailureAt?: string;
          readonly facetFailureCode?: string;
          readonly causeCode?: string;
        };
      }[];
    }>(`fixture/memory-proof-completion/${runId}`);
  }

  async memoryProofFailure(runId: string) {
    return await this.#ctx.storage.get(`fixture/memory-proof-failure/${runId}`);
  }

  async #setMemoryProofPhase(runId: string, phase: string) {
    await this.#ctx.storage.put(`fixture/memory-proof-phase/${runId}`, { runId, phase });
  }

  async recordMemoryProofFailure(
    runId: string,
    processId: string,
    source: ProductFixtureMemoryProofFailure["source"],
    failure: unknown,
  ) {
    const causes = serializeHarnessRequestFacetFailure(failure);
    const record: ProductFixtureMemoryProofFailure = {
      source,
      ...(source === "process" ? { processId } : {}),
      error: causes[0]?.message ?? String(failure),
      causes,
    };
    await this.#ctx.storage.put(`fixture/memory-proof-failure/${runId}`, {
      runId,
      failure: record,
    });
    await this.#env.PRODUCT_FIXTURE.getByName("product-fixture").markMemoryProofFailed(
      runId,
      record,
    );
    return record;
  }

  override async runShard(input: HarnessProcessExecutionShardInput, requestContextId: string) {
    const isMemoryProof = input.processes.some(
      (process) => process.processId === "product-memory-proof",
    );
    if (isMemoryProof) {
      this.#memoryProofRunId = input.runId;
      const selected = input.processes.find(
        (process) => process.processId === "product-memory-proof",
      );
      if (selected === undefined) throw new Error("The memory process is missing.");
      this.#memoryModuleInventory = await memoryModuleInventory(selected.modules);
      await this.#setMemoryProofPhase(input.runId, "runShard-entered");
    }
    const running = super.runShard(input, requestContextId);
    if (isMemoryProof)
      void running
        .then(async (result) => {
          await this.#ctx.storage.put(`fixture/memory-proof-completion/${input.runId}`, {
            runId: input.runId,
            processes: result.processes.map(({ processId, status, recoveryId, error }) => ({
              processId,
              status,
              ...(recoveryId === undefined ? {} : { recoveryId }),
              ...(error === undefined ? {} : { error }),
            })),
          });
          await this.#setMemoryProofPhase(input.runId, "runShard-completed");
        })
        .catch(async (cause) => {
          await this.#setMemoryProofPhase(input.runId, "runShard-failed");
          await this.recordMemoryProofFailure(
            input.runId,
            input.processes.find((process) => process.processId === "product-memory-proof")
              ?.processId ?? "product-memory-proof",
            "shard",
            cause instanceof Error ? cause.message : String(cause),
          );
        });
    return running;
  }

  async evidence() {
    const terminal = await this.ctx.storage.list<{
      readonly stopped: boolean;
      readonly joined: {
        readonly invocationRpc: boolean;
        readonly fetch: boolean;
        readonly ports: boolean;
      };
      readonly request?: { readonly requestId: string };
    }>({ prefix: "harness-process-terminal/v1/" });
    const resumes = await this.ctx.storage.list<{
      readonly phase: string;
      readonly prepared?: unknown;
      readonly failure?: unknown;
    }>({ prefix: "harness-process-resume/v1/" });
    return {
      terminal: [...terminal.values()].map((row) => ({
        stopped: row.stopped,
        joined: row.joined,
        requestId: row.request?.requestId,
      })),
      resumes: [...resumes.values()].map((row) => ({
        phase: row.phase,
        prepared: row.prepared !== undefined,
        failure: row.failure,
      })),
    };
  }

  async startLegacyMemoryProof(input: HarnessProcessExecutionShardInput, requestContextId: string) {
    const selected = input.processes.find(
      (process) => process.processId === "product-memory-proof",
    );
    if (selected === undefined || selected.targetPreparedRelease === undefined)
      throw new Error("The C memory proof has no selected process release.");
    const capability = this.#env.PRODUCT_FIXTURE.getByName(
      "product-fixture",
    ) as unknown as ProductFixtureCapability;
    await this.#setMemoryProofPhase(input.runId, "reading-r18-inputs");
    const raw = await readR18Inputs(capability);
    const legacyModules = await legacyModuleMap(
      this.#env.PRODUCT_FACET_SOURCE,
      selected.targetPreparedRelease,
      raw,
    );
    this.#legacyModuleSet = Object.freeze({ ...legacyModules, ...memoryNativeModule(this.#env) });
    const inputModules = copyLegacyModuleSnapshot(this.#legacyModuleSet);
    await this.#setMemoryProofPhase(input.runId, "legacy-module-map-built");
    const processes = input.processes.map((process) =>
      process.processId === selected.processId ? { ...process, modules: inputModules } : process,
    );
    // The old full module map exceeds Workerd's RPC cap, so this proof-only baseline calls public runShard locally.
    const running = this.runShard({ ...input, processes }, requestContextId);
    this.#ctx.waitUntil(
      running
        .catch((cause) => {
          return this.recordMemoryProofFailure(input.runId, selected.processId, "shard", cause);
        })
        .finally(() => {
          this.#legacyModuleSet = undefined;
        }),
    );
    return { started: true } as const;
  }

  protected override processExecutionHooks(): HarnessProcessExecutionHooks | undefined {
    return {
      afterActivation: async ({ process }) => {
        if (process.processId !== "product-memory-proof") return;
        if (this.#memoryProofRunId === undefined)
          throw new Error("The held memory proof lost its run identity.");
        await this.#setMemoryProofPhase(this.#memoryProofRunId, "after-activation-hook-entered");
        await this.#env.PRODUCT_FIXTURE.getByName("product-fixture").markMemoryProofReady(
          this.#memoryProofRunId,
          this.#legacyModuleSet !== undefined,
          this.#memoryModuleInventory,
        );
        await this.#setMemoryProofPhase(this.#memoryProofRunId, "activation-held");
        await new Promise<void>(() => undefined);
      },
      beforeCleanup: async ({ runId, process, failure }) => {
        if (process.processId !== "product-memory-proof" || failure === undefined) return "cleanup";
        await this.recordMemoryProofFailure(runId, process.processId, "process", failure);
        return "cleanup";
      },
    };
  }
}

export class ProductFixturePlacementStore extends HarnessProcessPlacementStoreObject {
  async writerStatus(owner: string) {
    return { writer: (await this.readWriter(owner)) !== undefined };
  }

  async memoryProofStatus(owner: string, processId: string) {
    const storedOwner = await this.ctx.storage.get<string>("harness-process-placement-owner-v1");
    const writer = await this.readWriter(owner);
    if (writer === undefined)
      return {
        objectName: this.ctx.id.name ?? null,
        requestedOwner: owner,
        storedOwner: storedOwner ?? null,
        writer: false,
        recovery: [],
        slots: undefined,
      } as const;
    const [records, slots] = await Promise.all([
      this.listRecovery(owner, writer),
      this.load(owner, writer),
    ]);
    return {
      objectName: this.ctx.id.name ?? null,
      requestedOwner: owner,
      storedOwner: storedOwner ?? null,
      writer: true,
      recovery: records
        .filter((record) => record.processId === processId)
        .map((record) => ({
          state: record.state,
          identityState: record.identityState,
          incarnationNonce: record.incarnationNonce,
          lease: record.lease,
          lastFailure: record.lastFailure,
        })),
      slots: slots?.slots.map((slot) => ({
        codeId: slot.codeId,
        index: slot.index,
        generation: slot.generation,
        held: slot.holder !== undefined,
        permitted: slot.holder?.permitted,
        residentBytes: slot.holder?.residentBytes,
      })),
    } as const;
  }
}

export default {
  async fetch(request: Request, env: ProductWorkerEnv, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const capability = env.PRODUCT_FIXTURE.getByName("product-fixture");
      if (path === "/heap-probe") {
        const target = url.searchParams.get("target");
        const action = url.searchParams.get("action");
        const bytes = Number(url.searchParams.get("bytes"));
        if (
          (target !== "shard" && target !== "capability") ||
          (action !== "hold" && action !== "release")
        )
          return Response.json({ error: "invalid heap probe request" }, { status: 400 });
        const probe =
          target === "shard"
            ? env.PROCESS_EXECUTION_SHARDS.getByName("memory-diagnostic-shard")
            : env.PRODUCT_FIXTURE.getByName("memory-diagnostic-capability");
        const result =
          action === "hold" ? await probe.holdHeapProbe(bytes) : await probe.releaseHeapProbe();
        return Response.json({ target, action, ...result });
      }
      if (path === "/memory-seed") {
        const modulePath = url.searchParams.get("path");
        const offsetValue = url.searchParams.get("offset");
        const totalBytesValue = url.searchParams.get("totalBytes");
        const sha256 = url.searchParams.get("sha256");
        if (
          modulePath === null ||
          offsetValue === null ||
          totalBytesValue === null ||
          sha256 === null
        )
          return Response.json({ error: "invalid module chunk metadata" }, { status: 400 });
        const offset = Number(offsetValue);
        const totalBytes = Number(totalBytesValue);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(totalBytes))
          return Response.json({ error: "invalid module chunk metadata" }, { status: 400 });
        const bytes = await request.arrayBuffer();
        try {
          return Response.json(
            await capability.seedR18ModuleChunk(modulePath, offset, totalBytes, sha256, bytes),
          );
        } catch (cause) {
          return Response.json(
            { error: cause instanceof Error ? cause.message : String(cause) },
            { status: 500 },
          );
        }
      }
      if (path === "/memory-start") {
        const mode = url.searchParams.get("mode");
        const runId = url.searchParams.get("runId");
        if ((mode !== "before" && mode !== "after") || runId === null)
          return Response.json({ error: "invalid proof request" }, { status: 400 });
        const result = await setupProductRun(env, "codex", {
          mode,
          runId,
          waitUntil: (promise) => ctx.waitUntil(promise),
        });
        return Response.json(result);
      }
      if (path === "/memory-ready") {
        const runId = url.searchParams.get("runId");
        if (runId === null) return Response.json({ error: "missing run ID" }, { status: 400 });
        const readiness = await capability.waitForMemoryProof(runId);
        return Response.json(readiness, { status: "failure" in readiness ? 500 : 200 });
      }
      if (path === "/memory-failure-probe") {
        const runId = url.searchParams.get("runId");
        if (runId === null) return Response.json({ error: "missing run ID" }, { status: 400 });
        const pendingReadiness = capability.waitForMemoryProof(runId);
        const shard = env.PROCESS_EXECUTION_SHARDS.getByName(
          "memory-failure-probe",
        ) as unknown as ProductFixtureShard;
        await shard.recordMemoryProofFailure(runId, "product-memory-proof", "process", {
          name: "HarnessProcessPlacementError",
          _tag: "HarnessProcessPlacementError",
          kind: "prepare-failed",
          message: "The fresh facet could not be prepared inert.",
          details: { facetFailureAt: "prepare", facetFailureCode: "rpc-error" },
          cause: {
            name: "HarnessRequestFacetError",
            _tag: "HarnessRequestFacetError",
            message: "Harness host could not prepare the committed checkpoint inert.",
            cause: {
              name: "CodexNativeCheckpointRestoreError",
              code: "CODEX_CHECKPOINT_RESTORE",
              operation: "resume",
              message: "Synthetic Codex checkpoint restore failure.",
            },
          },
        });
        const readiness = await pendingReadiness;
        return Response.json(readiness, { status: "failure" in readiness ? 500 : 200 });
      }
      if (path === "/memory-status") {
        const runId = url.searchParams.get("runId");
        const owner = url.searchParams.get("owner");
        if (runId === null || owner === null)
          return Response.json({ error: "missing run ID or shard owner" }, { status: 400 });
        const shard = env.PROCESS_EXECUTION_SHARDS.getByName(
          owner,
        ) as unknown as ProductFixtureShard;
        const placement = env.PLACEMENT_STORES.getByName(
          owner,
        ) as unknown as ProductFixturePlacementStore;
        const [shardPhase, completion, failure, readiness, observations, placementStatus] =
          await Promise.all([
            shard.memoryProofPhase(runId),
            shard.memoryProofCompletion(runId),
            shard.memoryProofFailure(runId),
            capability.memoryProofStatus(runId),
            capability.observations(),
            placement.memoryProofStatus(owner, "product-memory-proof"),
          ]);
        return Response.json({
          runId,
          owner,
          shardPhase,
          completion,
          failure,
          readiness,
          placementStatus,
          observations,
        });
      }
      if (
        path !== "/positive" &&
        path !== "/codex-same" &&
        path !== "/mismatch" &&
        !path.startsWith("/failure/")
      )
        return Response.json({ error: "unknown scenario" }, { status: 404 });
      const mismatch = path === "/mismatch";
      return Response.json(
        await runProductScenario(
          env,
          mismatch,
          path.startsWith("/failure/") ? path.slice("/failure/".length) : undefined,
          path === "/codex-same" ? "codex" : "claude-code",
        ),
      );
    } catch (cause) {
      const errors = [];
      for (let error: unknown = cause, i = 0; error !== undefined && i < 8; i++) {
        errors.push(
          error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        );
        error = error instanceof Error ? error.cause : undefined;
      }
      let observations: unknown;
      try {
        observations = await env.PRODUCT_FIXTURE.getByName("product-fixture").observations();
      } catch (observationFailure) {
        observations = {
          unavailable: true,
          error:
            observationFailure instanceof Error
              ? observationFailure.message
              : String(observationFailure),
        };
      }
      return new Response(JSON.stringify({ errors, observations }), { status: 500 });
    }
  },
};
