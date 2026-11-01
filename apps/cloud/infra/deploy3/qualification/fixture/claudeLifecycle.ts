import { readRpcData, rpcStubOwner, withRpcStub } from "../../../../src/rpc/Resources.ts";
import * as Schema from "effect/Schema";
import { RunnerTurn, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type { QualifierExecutionContext } from "./proofContext.ts";
import { claudeLane, type ClaudeVariant } from "./claudeCTransport.ts";
import {
  claudeCreationInput,
  claudeReplacementInput,
  type ClaudeCreated,
} from "./claudeLifecycleInputs.ts";
import { createHarnessDurableState } from "../../../../src/harness/HarnessDurableState.ts";
import type { HarnessProcessContinuationInput } from "../../../../src/harness/HarnessProcessResume.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestOffer,
} from "../../../../src/harness/HarnessRunStore.ts";
import { assert, control, encoder, supervisor, RUN_CONTROL_KEY } from "./common.ts";
import { CLAUDE_PHASES } from "./claudeScenario.ts";

const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const encodeTurn = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const decodeEvent = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerItem)));

/** Owns one fresh public C conversation, its sole completed-checkpoint replacement, and final join. */
export class ClaudeLifecycle {
  #created: ClaudeCreated | undefined;
  #resumed = false;
  #checkpoint: HarnessRequestCheckpoint | undefined;
  #firstRequest: HarnessRequestOffer | undefined;
  #lastContinuation: HarnessProcessContinuationInput | undefined;
  #completedTurns = 0;
  readonly owner: QualifierExecutionContext;
  readonly variant: ClaudeVariant;
  constructor(owner: QualifierExecutionContext, variant: ClaudeVariant) {
    this.owner = owner;
    this.variant = variant;
  }
  private async context() {
    const config = await this.owner.config();
    const lane = claudeLane(config.runId, this.variant);
    return {
      config,
      lane,
      durable: createHarnessDurableState(this.owner.environment(), lane.runId),
      shard: this.owner.environment().PROCESS_EXECUTION_SHARDS.getByName(lane.shardOwner),
    };
  }
  private async cold() {
    assert(!this.#created, "Claude fresh creation cannot repeat");
    const { config, lane, durable, shard } = await this.context();
    using _shardOwner = rpcStubOwner(shard);
    const c = await this.owner.claude.c(this.variant, "work");
    const seed = await this.owner.artifact(`${this.variant}-run-seed`, encoder.encode(lane.runId));
    const input = claudeCreationInput(config, this.variant, seed);
    await this.owner.append("claude-public-call", { method: "startFreshProcess", input });
    const created = await c.startFreshProcess(input);
    assert(created.status === "created", "Claude fresh creation did not bind its original session");
    this.#created = created;
    const observed = await c.processCreationStatus({ runId: lane.runId, control: control(1) });
    const a = await readRpcData(
      durable.threadSupervisor.execute({
        type: "read",
        runId: lane.runId,
        control: control(1),
      }),
    );
    const journal = await readRpcData(
      durable.runStore.execute({ type: "read", runId: lane.runId }),
    );
    assert(
      observed.status === "bound" &&
        observed.nativeSessionId === created.nativeSessionId &&
        a.snapshot.nativeSessionId === created.nativeSessionId &&
        a.currentPublisher.facetNonce === created.identity.incarnationNonce &&
        journal.snapshot.requests?.entries.length === 0,
      "Claude initial public stores did not bind the fresh native identity",
    );
    this.#checkpoint = created.checkpoint;
    const receipt = {
      created,
      observed,
      supervisor: a,
      journal,
      evidence: await readRpcData(shard.evidence()),
    };
    await this.owner.saveState(`claude-${this.variant}-created`, receipt);
    return receipt;
  }
  async turn(turn: 1 | 2 | 3) {
    assert(
      turn === this.#completedTurns + 1,
      "Claude turns must complete once in their frozen order",
    );
    if (turn === 1) await this.cold();
    assert(this.#created && this.#checkpoint, "Claude has no public fresh session");
    assert(turn === 1 || this.#resumed, "Claude requires its single replacement after turn 1");
    const { config, lane, durable, shard } = await this.context();
    using _shardOwner = rpcStubOwner(shard);
    const phase = CLAUDE_PHASES[turn - 1]!;
    const c = await this.owner.claude.c(this.variant, phase);
    const initial = decodeTurn(config.claude.runtime.turnJson[this.variant][turn - 1]!);
    assert(
      initial.providerThread.nativeThreadRef === null,
      "Claude native identity must come from public creation",
    );
    const bound = {
      ...initial,
      providerThread: {
        ...initial.providerThread,
        nativeThreadRef: {
          driver: initial.providerThread.driver,
          nativeId: this.#created.nativeSessionId,
          strength: "strong" as const,
        },
      },
    };
    const request = {
      requestId: `${this.variant}-turn-${turn}`,
      input: await this.owner.artifact(
        `${this.variant}-turn-${turn}-input`,
        encoder.encode(encodeTurn(bound)),
      ),
    };
    const parentCheckpoint = this.#checkpoint;
    const epoch = turn === 1 ? 1 : 2;
    let running;
    if (turn === 1) {
      this.#firstRequest = request;
      running = c.runCreatedProcess(
        { runId: lane.runId, operationId: lane.creationOperationId, request },
        request.requestId,
      );
    } else {
      const boundary = await readRpcData(shard.modelRecoveryEvidence(lane.runId));
      assert(
        boundary?.boundary.nativeSessionId === this.#created.nativeSessionId,
        "Claude continuation lost its durable native owner",
      );
      const continuation: HarnessProcessContinuationInput = {
        runId: lane.runId,
        processId: lane.processId,
        executionOperationId: lane.creationOperationId,
        resumeOperationId: lane.resumeOperationId,
        control: control(2),
        afterTurn: "keep-alive",
        runStore: {
          controlKey: RUN_CONTROL_KEY,
          supervisor,
          currentPublisher: boundary.boundary.requestPublisher,
          request,
          checkpoint: parentCheckpoint,
        },
      };
      this.#lastContinuation = continuation;
      running = c.continueProcess(continuation, request.requestId);
    }
    const finishStore = this.owner.environment().HARNESS_RUN_STORE.getByName(lane.runId);
    using _finishStoreOwner = rpcStubOwner(finishStore);
    const finished = await Promise.race([
      readRpcData(finishStore.waitForFinish(request.requestId)),
      running.then((result) => {
        throw new Error(
          `Claude C returned before its persisted checkpoint barrier: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const entry = finished.snapshot.requests?.entries.find(
      (item) => item.request.requestId === request.requestId,
    );
    assert(
      entry?.status === "completed" && entry.finish?.status === "completed",
      "Claude public native request did not complete",
    );
    const files = await this.owner.material(request.requestId);
    const current = await readRpcData(
      durable.threadSupervisor.execute({
        type: "read",
        runId: lane.runId,
        control: control(epoch),
      }),
    );
    const committed = await c.commitProcessCheckpoint({
      runId: lane.runId,
      processId: lane.processId,
      executionOperationId: lane.creationOperationId,
      processOperationId: turn === 1 ? lane.creationOperationId : lane.resumeOperationId,
      requestId: request.requestId,
      nativeSessionId: this.#created.nativeSessionId,
      control: control(epoch),
      publisher: current.currentPublisher,
      checkpoint: files,
    });
    assert(committed.status === "committed", "Claude C did not commit its completed checkpoint");
    const executed = await running;
    const process = executed.processes[0];
    assert(
      executed.processes.length === 1 &&
        process?.processId === lane.processId &&
        process.identity &&
        process.status === (turn === 1 ? "settled" : "idle"),
      "Claude C returned a failed or unowned process",
    );
    const events = (await this.owner.runnerEvents(request.requestId)).map((row) =>
      decodeEvent(row.eventJson),
    );
    const terminals = events.filter(
      (item) => item.kind === "provider" && item.event.type === "turn.terminal",
    );
    assert(terminals.length === 1, "Claude request has no unique native terminal");
    const native = terminals[0]!;
    assert(
      native.kind === "provider" &&
        native.event.status === "completed" &&
        native.event.providerThreadId === initial.providerThread.id &&
        native.event.driver === "claudeAgent",
      "Claude terminal does not match the completed provider thread",
    );
    this.#checkpoint = entry.finish.checkpoint;
    this.#completedTurns = turn;
    const receipt = {
      phase,
      requestId: request.requestId,
      request,
      status: "committed" as const,
      runStore: finished,
      files,
      commit: committed,
      shard: executed,
      terminal: {
        requestId: request.requestId,
        nativeSessionId: this.#created.nativeSessionId,
        status: "completed" as const,
        event: native,
      },
      parentCheckpoint,
      checkpoint: this.#checkpoint,
      loadedPreparedRelease: await this.owner.readClaudeLoadedRelease(
        process.identity.incarnationNonce,
      ),
    };
    await this.owner.saveState(`claude-${this.variant}-turn-${turn}`, receipt);
    return receipt;
  }
  async replace() {
    assert(
      this.#created && this.#firstRequest && this.#completedTurns === 1 && !this.#resumed,
      "Claude replacement requires exactly one completed turn",
    );
    const { config, lane, durable, shard } = await this.context();
    using _shardOwner = rpcStubOwner(shard);
    const c = await this.owner.claude.c(this.variant, "resume");
    const first = await this.owner.state<Awaited<ReturnType<ClaudeLifecycle["turn"]>>>(
      `claude-${this.variant}-turn-1`,
    );
    const before = await readRpcData(
      durable.threadSupervisor.execute({
        type: "read",
        runId: lane.runId,
        control: control(1),
      }),
    );
    const source = await readRpcData(shard.modelRecoveryEvidence(lane.runId));
    assert(
      source?.boundary.nativeSessionId === this.#created.nativeSessionId,
      "Claude replacement lost its completed checkpoint",
    );
    const input = claudeReplacementInput({
      config,
      variant: this.variant,
      created: this.#created,
      firstRequest: this.#firstRequest,
      requestPublisher: source.boundary.requestPublisher,
      publisher: before.currentPublisher,
    });
    const resumed = await c.resumeProcess(input);
    const previousIdentity = first.shard.processes[0]!.identity!;
    assert(
      resumed.status === "resumed" &&
        resumed.identity.loaderId !== previousIdentity.loaderId &&
        resumed.identity.incarnationNonce !== previousIdentity.incarnationNonce,
      "Claude replacement did not create a new public facet",
    );
    const after = await readRpcData(
      durable.threadSupervisor.execute({
        type: "read",
        runId: lane.runId,
        control: control(2),
      }),
    );
    assert(
      after.snapshot.nativeSessionId === this.#created.nativeSessionId &&
        after.currentPublisher.facetNonce === resumed.identity.incarnationNonce,
      "Claude replacement changed the native conversation",
    );
    const oldRelease = await this.owner.writerReleaseFor(previousIdentity.incarnationNonce);
    const publication = await this.owner.append("claude-replacement-publication-observed", {
      variant: this.variant,
      resumed,
      after,
      oldRelease,
    });
    assert(
      oldRelease.sequence < publication.sequence,
      "Claude replacement preceded old-writer join and release",
    );
    const oldControllerDenied = await readRpcData(
      durable.threadSupervisor.execute({ type: "read", runId: lane.runId, control: control(1) }),
    ).then(
      () => false,
      () => true,
    );
    assert(oldControllerDenied, "Claude replaced controller still has authority");
    this.#resumed = true;
    const receipt = {
      resumed,
      before,
      after,
      oldRelease,
      publication,
      oldControllerDenied,
      checkpoint: this.#checkpoint,
    };
    await this.owner.saveState(`claude-${this.variant}-replacement`, receipt);
    return receipt;
  }
  async finish() {
    assert(
      this.#created &&
        this.#resumed &&
        this.#completedTurns === 3 &&
        this.#lastContinuation &&
        this.#checkpoint,
      "Claude final stop requires three completed turns and one replacement",
    );
    const { lane, shard } = await this.context();
    using _shardOwner = rpcStubOwner(shard);
    const boundary = await readRpcData(shard.modelRecoveryEvidence(lane.runId));
    assert(
      boundary?.boundary.nativeSessionId === this.#created.nativeSessionId,
      "Claude final stop lost its native owner",
    );
    const c = await this.owner.claude.c(this.variant, "finish");
    const stopped = await c.stopIdleProcess({
      ...this.#lastContinuation,
      runStore: {
        ...this.#lastContinuation.runStore,
        currentPublisher: boundary.boundary.requestPublisher,
        checkpoint: this.#checkpoint,
      },
    });
    const ownership = await withRpcStub(
      this.owner.environment().PLACEMENT_STORES.getByName(lane.shardOwner),
      (stub) => readRpcData(stub.ownership(lane.shardOwner)),
    );
    assert(
      ownership.writer === null && ownership.leases === 0,
      "Claude still owns placement resources after final stop",
    );
    const evidence = await readRpcData(shard.evidence());
    assert(
      evidence.terminal.length > 0 &&
        evidence.terminal.every(
          ({ value }) =>
            value.nativeSessionId === this.#created!.nativeSessionId &&
            value.stopped &&
            value.joined.invocationRpc &&
            value.joined.fetch &&
            value.joined.ports,
        ),
      "Claude final native lifetime is not fully joined",
    );
    const result = {
      stopped,
      ownership,
      evidence,
      nativeSessionId: this.#created.nativeSessionId,
      completedTurns: this.#completedTurns,
      replacementCount: 1 as const,
      creation: this.#created,
    };
    await this.owner.saveState(`claude-${this.variant}-finished`, result);
    return result;
  }
}
