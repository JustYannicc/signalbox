import type { QualifierExecutionContext } from "./proofContext.ts";
import type { Configuration } from "./configuration.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestOffer,
} from "../../../../src/harness/HarnessRunStore.ts";
import type { HarnessProcessCreationInput } from "../../../../src/harness/HarnessProcessCreation.ts";
import type {
  HarnessProcessResumeOperationInput,
  HarnessProcessContinuationInput,
} from "../../../../src/harness/HarnessProcessResume.ts";
import { preparedReleaseAsset } from "../../../../src/harness/HarnessProcessPlacement.ts";
import { createHarnessDurableState } from "../../../../src/harness/HarnessDurableState.ts";
import {
  assert,
  control,
  CREATION_ID,
  PROCESS_ID,
  RESUME_ID,
  publisherKey,
  requestPublisherKey,
  supervisor,
  RUN_CONTROL_KEY,
  encoder,
  jsonBytes,
  sha256,
  errorRecord,
} from "./common.ts";

type Created = Awaited<
  ReturnType<ReturnType<QualifierExecutionContext["shard"]>["startFreshProcess"]>
>;

export class Lifecycle {
  #created: Created | undefined;
  #resumed:
    | Awaited<ReturnType<ReturnType<QualifierExecutionContext["shard"]>["resumeProcess"]>>
    | undefined;
  #checkpoint: HarnessRequestCheckpoint | undefined;
  #turnOneOffer: HarnessRequestOffer | undefined;
  #lastContinuation: HarnessProcessContinuationInput | undefined;
  readonly owner: QualifierExecutionContext;
  constructor(owner: QualifierExecutionContext) {
    this.owner = owner;
  }
  currentCheckpoint() {
    assert(this.#checkpoint, "No committed logical checkpoint exists");
    return this.#checkpoint;
  }
  private facet(config: Configuration) {
    const engine = Object.entries(config.expectedRelease.plan.preparedModules).find(
      ([, value]) => value.type === "wasm" && value.path.endsWith("codex/engine.wasm"),
    );
    assert(engine, "The frozen official engine is absent from the selected prepared release");
    return {
      processId: PROCESS_ID,
      codeId: config.expectedRelease.artifact.releaseId,
      residentBytes: 104 * 1024 * 1024,
      mainModule: "qualifier-facet.mjs",
      entrypoint: "CodexFacet",
      modules: {
        "qualifier-facet.mjs": {
          js: "export { CodexFacet } from './qualifier-implementation.mjs';\n",
        },
        "codex-engine.wasm": preparedReleaseAsset(config.expectedRelease, engine[0]),
      },
    } as const;
  }
  async cold() {
    const config = await this.owner.config();
    const shard = this.owner.shard();
    const seed = await this.owner.artifact("run-seed", encoder.encode(config.runId));
    const input: HarnessProcessCreationInput = {
      runId: config.runId,
      operationId: CREATION_ID,
      run: {
        type: "initialize",
        seed: {
          identity: {
            runId: config.runId,
            hostId: "combined-official-qualifier",
            threadId: "combined-thread",
            logicalTurnId: "combined-three-turns",
            filesystemId: "combined-workspace",
          },
          locator: seed,
          config: seed,
          artifacts: [seed],
        },
        controlKey: RUN_CONTROL_KEY,
        supervisorKey: supervisor.supervisorKey,
        claimId: supervisor.claimId,
        requestId: "initialize",
      },
      controllerClaim: control(1),
      publisherKey: publisherKey(1),
      requestPublisherKey: requestPublisherKey(1),
      requestModeId: "request-mode",
      facet: {
        ...this.facet(config),
        facetEnv: {
          QUALIFIER_CONFIGURATION: { runId: config.runId, workerName: config.workerName },
        },
        productBootstrap: this.bootstrap(config),
        targetPreparedRelease: config.expectedRelease,
      },
    };
    await this.owner.append("public-call", { method: "startFreshProcess", input });
    const created = await shard.startFreshProcess(input);
    this.#created = created;
    assert(
      created.status === "created",
      "Cold creation did not return its original bound official session",
    );
    this.owner.model.bind(created.nativeSessionId);
    const durable = createHarnessDurableState(this.owner.environment(), config.runId);
    const observed = await shard.processCreationStatus({
      runId: config.runId,
      control: control(1),
    });
    const a = await durable.threadSupervisor.execute({
      type: "read",
      runId: config.runId,
      control: control(1),
    });
    const journal = await durable.runStore.execute({ type: "read", runId: config.runId });
    assert(
      observed.status === "bound" && observed.nativeSessionId === created.nativeSessionId,
      "The durable cold identity reread changed",
    );
    assert(
      a.snapshot.nativeSessionId === created.nativeSessionId &&
        a.currentPublisher.facetNonce === created.identity.incarnationNonce,
      "The supervisor did not bind the runtime-issued UUID",
    );
    assert(
      journal.snapshot.requests?.entries.length === 0,
      "Initial official creation already contains a completed turn",
    );
    assert(
      this.owner.model.current().incarnation === created.identity.incarnationNonce,
      "Cold model bootstrap and C returned different physical facets",
    );
    this.#checkpoint = created.checkpoint;
    await this.owner.recordActiveCheckpoint(created.checkpoint.native.id);
    await this.owner.saveState("created", { created, observed, a, journal });
  }
  private bootstrap(config: Configuration) {
    return {
      provider: "codex",
      preparedReleaseId: config.expectedRelease.artifact.releaseId,
      restoreMode: "same-variant-serialized-checkpoint",
    } as const;
  }
  private async offer(turn: number) {
    const config = await this.owner.config();
    const initial = JSON.parse(config.turnJson[turn - 1]!);
    assert(this.#created, "The official UUID must exist before accepting a turn");
    initial.providerThread.nativeThreadRef = {
      driver: "codex",
      nativeId: this.#created.nativeSessionId,
      strength: "strong",
    };
    const reference = await this.owner.artifact(
      `turn-${turn}-input`,
      encoder.encode(JSON.stringify(initial)),
    );
    return { requestId: `turn-${turn}`, input: reference };
  }
  async turn(turn: number) {
    const config = await this.owner.config();
    if (turn === 1) await this.cold();
    assert(this.#created && this.#checkpoint, "No committed official native checkpoint");
    const parentCheckpoint = this.#checkpoint;
    const request = await this.offer(turn);
    const shard = this.owner.shard();
    this.owner.model.begin(turn);
    const epoch = turn === 1 ? 1 : 2;
    const processOperationId = turn === 1 ? CREATION_ID : RESUME_ID;
    let running;
    if (turn === 1) {
      this.#turnOneOffer = request;
      await this.owner.append("public-call", {
        method: "runCreatedProcess",
        request,
        identity: this.#created.identity,
      });
      running = shard.runCreatedProcess(
        { runId: config.runId, operationId: CREATION_ID, request },
        request.requestId,
      );
    } else {
      assert(this.#resumed, "Continuation requires the sole completed-turn replacement");
      const boundary = await shard.modelRecoveryEvidence(config.runId);
      assert(
        boundary && boundary.boundary.nativeSessionId === this.#created.nativeSessionId,
        "Continuation lost its durable logical native owner",
      );
      const currentPublisher = boundary.boundary.requestPublisher;
      const continuation: HarnessProcessContinuationInput = {
        runId: config.runId,
        processId: PROCESS_ID,
        executionOperationId: CREATION_ID,
        resumeOperationId: RESUME_ID,
        control: control(2),
        afterTurn: "keep-alive",
        runStore: {
          controlKey: RUN_CONTROL_KEY,
          supervisor,
          currentPublisher,
          request,
          checkpoint: parentCheckpoint,
        },
      };
      this.#lastContinuation = continuation;
      await this.owner.append("public-call", { method: "continueProcess", turn, continuation });
      running = shard.continueProcess(continuation, request.requestId);
    }
    const finished = await Promise.race([
      this.owner.model.peer.failure.then(async (cause) => {
        await this.owner.artifact(
          "model-first-failure-snapshot",
          jsonBytes(this.owner.model.peer.snapshot()),
        );
        await this.owner.append("model-first-failure", { failure: errorRecord(cause) });
        throw cause;
      }),
      this.owner
        .environment()
        .HARNESS_RUN_STORE.getByName(config.runId)
        .waitForFinish(request.requestId),
      running.then((result) => {
        throw new Error(
          `C returned before the persisted completed checkpoint barrier: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const entry = finished.snapshot.requests?.entries.find(
      (item) => item.request.requestId === request.requestId,
    );
    assert(
      entry?.status === "completed" && entry.finish?.status === "completed",
      "Public native request did not finish successfully",
    );
    const files = await this.owner.material(request.requestId);
    const durable = createHarnessDurableState(this.owner.environment(), config.runId);
    const current = await durable.threadSupervisor.execute({
      type: "read",
      runId: config.runId,
      control: control(epoch),
    });
    await this.owner.append("public-call", {
      method: "commitProcessCheckpoint",
      requestId: request.requestId,
      checkpointId: files.checkpointId,
    });
    const committed = await shard.commitProcessCheckpoint({
      runId: config.runId,
      processId: PROCESS_ID,
      executionOperationId: CREATION_ID,
      processOperationId,
      requestId: request.requestId,
      nativeSessionId: this.#created.nativeSessionId,
      control: control(epoch),
      publisher: current.currentPublisher,
      checkpoint: files,
    });
    assert(committed.status === "committed", "C did not return a committed checkpoint receipt");
    const executed = await running;
    const process = executed.processes[0];
    const physical = this.owner.model.current();
    const identity = process?.identity;
    assert(
      process &&
        identity?.incarnationNonce === physical.incarnation &&
        identity.loaderId === physical.loaderId,
      "The actual executed process does not match the verified physical model owner",
    );
    assert(
      process.status === (turn === 1 ? "settled" : "idle"),
      "C returned a recoverable or failed process",
    );
    this.#checkpoint = entry.finish.checkpoint;
    await this.owner.recordActiveCheckpoint(this.#checkpoint.native.id);
    const after = await durable.threadSupervisor.execute({
      type: "read",
      runId: config.runId,
      control: control(epoch),
    });
    const journal = await durable.runStore.execute({ type: "read", runId: config.runId });
    const evidence = await shard.evidence();
    const receipt = {
      turn,
      request,
      nativeSessionId: this.#created.nativeSessionId,
      identity,
      parentCheckpoint,
      checkpoint: this.#checkpoint,
      committed,
      executed,
      after,
      journal,
      evidence,
    };
    await this.owner.saveState(`turn-${turn}`, receipt);
    await this.owner.model.complete(turn);
    return receipt;
  }
  async replace() {
    const config = await this.owner.config();
    assert(
      this.#created && this.#turnOneOffer && this.#checkpoint && !this.#resumed,
      "Replacement lacks exactly one completed turn",
    );
    const initial = await this.owner.state<{ created: Created }>("created");
    const first = await this.owner.knownTurn(1);
    assert(first.committed.status === "committed", "Replacement preceded turn-1 commit");
    const durable = createHarnessDurableState(this.owner.environment(), config.runId);
    const before = await durable.threadSupervisor.execute({
      type: "read",
      runId: config.runId,
      control: control(1),
    });
    const source = await this.owner.shard().modelRecoveryEvidence(config.runId);
    assert(
      source && source.boundary.nativeSessionId === this.#created.nativeSessionId,
      "Logical replacement lost its source checkpoint boundary",
    );
    const operation: HarnessProcessResumeOperationInput = {
      runId: config.runId,
      previousProcessId: PROCESS_ID,
      previousOperationId: CREATION_ID,
      previousStepId: this.#turnOneOffer.requestId,
      runStore: {
        runId: config.runId,
        processId: PROCESS_ID,
        processOperationId: CREATION_ID,
        transitionOperationId: RESUME_ID,
        controlKey: RUN_CONTROL_KEY,
        supervisor,
        currentPublisher: source.boundary.requestPublisher,
        nextPublisherKey: requestPublisherKey(2),
        request: this.#turnOneOffer,
        checkpoint: initial.created!.checkpoint,
      },
      transition: {
        operationId: RESUME_ID,
        control: control(1),
        publisher: before.currentPublisher,
        nextControl: control(2),
        expectedFacetGeneration: before.currentPublisher.generation,
        targetPreparedRelease: config.expectedRelease,
      },
      facet: this.facet(config),
      productBootstrap: this.bootstrap(config),
    };
    await this.owner.append("public-call", { method: "resumeProcess", operation });
    const resumed = await this.owner.shard().resumeProcess(operation);
    assert(
      resumed.status === "resumed" &&
        resumed.identity.loaderId !== first.identity.loaderId &&
        resumed.identity.incarnationNonce !== first.identity.incarnationNonce,
      "The sole replacement did not create a different official process",
    );
    assert(
      this.owner.model.current().incarnation === resumed.identity.incarnationNonce,
      "Replacement model bootstrap and C returned different physical facets",
    );
    const after = await durable.threadSupervisor.execute({
      type: "read",
      runId: config.runId,
      control: control(2),
    });
    assert(
      after.snapshot.nativeSessionId === this.#created.nativeSessionId &&
        after.currentPublisher.facetNonce === resumed.identity.incarnationNonce,
      "Replacement changed the native conversation or failed publication",
    );
    const oldRelease = await this.owner.writerReleaseFor(first.identity.incarnationNonce);
    const publication = await this.owner.append("replacement-publication-observed", {
      resumed,
      after,
      oldRelease,
    });
    assert(
      oldRelease.sequence < publication.sequence,
      "Replacement publication preceded old-writer release evidence",
    );
    const stale = await durable.threadSupervisor
      .execute({ type: "read", runId: config.runId, control: control(1) })
      .then(
        () => false,
        () => true,
      );
    assert(stale, "Old controller remained authorized after publication");
    const placement = this.owner.environment().PLACEMENT_STORES.getByName(this.owner.shardOwner());
    const currentWriter = await placement.readWriter(this.owner.shardOwner());
    assert(
      currentWriter && JSON.stringify(currentWriter) !== JSON.stringify(oldRelease.writer),
      "Replacement did not establish a new placement writer",
    );
    const currentState = await placement.load(this.owner.shardOwner(), currentWriter);
    assert(currentState, "The current placement has no durable state");
    const oldWrite = await placement
      .save(this.owner.shardOwner(), oldRelease.writer, currentState)
      .then(
        () => ({ denied: false }),
        (cause) => ({ denied: true, cause: errorRecord(cause) }),
      );
    assert(oldWrite.denied, "The replaced placement writer could still publish");
    const currentStateAfter = await placement.load(this.owner.shardOwner(), currentWriter);
    const currentStateSha256 = await sha256(jsonBytes(currentState));
    assert(
      currentStateSha256 === (await sha256(jsonBytes(currentStateAfter))),
      "The denied old writer changed current placement state",
    );
    const oldWriterDenied = await this.owner.append("old-writer-publication-denied", {
      oldWriter: oldRelease.writer,
      currentWriter,
      oldWrite,
      currentStateSha256,
    });
    this.#resumed = resumed;
    const receipt = {
      resumed,
      before,
      after,
      oldRelease,
      publication,
      oldControllerDenied: stale,
      oldWriterDenied,
      evidence: await this.owner.shard().evidence(),
    };
    await this.owner.saveState("replacement", receipt);
    return receipt;
  }
  async finish() {
    const config = await this.owner.config();
    let stopped;
    let model;
    try {
      await this.owner.append("final-stop-attempted", {
        hasCreated: Boolean(this.#created),
        hasResumed: Boolean(this.#resumed),
        hasContinuation: Boolean(this.#lastContinuation),
      });
      assert(
        this.#created && this.#resumed && this.#lastContinuation && this.#checkpoint,
        "No completed idle official process is available for public stop",
      );
      const boundary = await this.owner.shard().modelRecoveryEvidence(config.runId);
      assert(
        boundary && boundary.boundary.nativeSessionId === this.#created.nativeSessionId,
        "Final stop lost its durable logical native owner",
      );
      const input = {
        ...this.#lastContinuation,
        runStore: {
          ...this.#lastContinuation.runStore,
          currentPublisher: boundary.boundary.requestPublisher,
          checkpoint: this.#checkpoint,
        },
      };
      await this.owner.append("public-call", { method: "stopIdleProcess", input });
      stopped = await this.owner.shard().stopIdleProcess(input);
    } finally {
      model = await this.owner.model.finish();
    }
    const ownership = await this.owner
      .environment()
      .PLACEMENT_STORES.getByName(this.owner.shardOwner())
      .ownership(this.owner.shardOwner());
    assert(
      ownership.writer === null && ownership.leases === 0,
      "Final official process still owns placement resources",
    );
    const evidence = await this.owner.shard().evidence();
    const selfSamples = {
      availability: "missing",
      reason:
        "This Workers runtime exposes no in-isolate JS used heap plus backingStorageSize sampler; the local V8 inspector metric is unavailable in production",
      observed: {
        performanceMemory: typeof Reflect.get(performance, "memory"),
        globalGc: typeof Reflect.get(globalThis, "gc"),
      },
      samples: [],
    };
    const result = {
      stopped,
      model,
      ownership,
      evidence,
      selfSamples,
      nativeSessionId: this.#created!.nativeSessionId,
      replacementCount: 1,
      completedTurns: 3,
    };
    await this.owner.saveState("finished", result);
    return result;
  }
}
