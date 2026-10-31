import type { QualifierExecutionContext } from "./proofContext.ts";
import {
  createClaudeCTransport,
  claudeLane,
  type ClaudeStep,
  type ClaudeVariant,
  type ClaudeStepPhase,
  type ClaudeCTransport,
} from "./claudeCTransport.ts";
import { ClaudeQualificationModelPeer } from "./claudeModelPeer.ts";
import { createClaudeWorkloadTransport } from "./claudeModelTransport.ts";
import { NATIVE_SESSION_UUID } from "../../../../src/harness/HarnessProcessCreation.ts";
import { assert, errorRecord } from "./common.ts";
import type { ClaudePersistedModelRecord } from "./claudeModelEvidence.ts";

import type { ClaudeIncarnation as Incarnation } from "./claudeScenario.ts";
export type { ClaudeIncarnation as Incarnation } from "./claudeScenario.ts";

/** Each selected variant has one non-replayable model owner and its own wire journal. */
export class ClaudeController {
  readonly #owner: QualifierExecutionContext;
  readonly #storage: DurableObjectStorage;
  readonly #models = new Map<ClaudeVariant, ReturnType<ClaudeController["openModel"]>>();
  constructor(owner: QualifierExecutionContext, storage: DurableObjectStorage) {
    this.#owner = owner;
    this.#storage = storage;
  }
  async prepare(input: Incarnation) {
    assert(
      input.incarnation.length > 0 &&
        input.loaderId.length > 0 &&
        (input.kind === "fresh" ||
          (NATIVE_SESSION_UUID.test(input.nativeSessionId) &&
            input.checkpointId.length > 0 &&
            /^[a-f0-9]{64}$/u.test(input.manifestSha256))),
      "Claude public checkpoint identity is incomplete",
    );
    const key = `claude/incarnation/${input.incarnation}`;
    assert(
      (await this.#storage.get(key)) === undefined,
      "Claude process incarnation preparation was repeated",
    );
    const record = await this.#owner.append("claude-public-incarnation-prepared", input);
    await this.#storage.put(key, { ...input, sequence: record.sequence });
    return record;
  }
  async active() {
    return await this.#storage.get<ClaudeStep>("claude/active-step");
  }
  async begin(step: ClaudeStep) {
    assert(
      step.requestId.length > 0 &&
        (step.variant === "baseline" || step.variant === "hooks") &&
        (step.phase === "work" || step.phase === "resume" || step.phase === "finish"),
      "Claude public C step identity is invalid",
    );
    const config = await this.#owner.config();
    assert(
      config.claude.runtime.purpose === "qualification" &&
        config.claude.expected[step.variant].artifact.provider === "claude-code",
      "Claude public C step is outside the selected qualification pair",
    );
    await this.#storage.transaction(async (tx) => {
      assert(!(await tx.get("claude/active-step")), "Another Claude C step is active");
      const key = `claude/step/${step.variant}/${step.requestId}/claim`;
      assert(!(await tx.get(key)), "This Claude C step was already claimed");
      await tx.put(key, step);
      await tx.put("claude/active-step", step);
    });
    const receipt = await this.#owner.append("claude-public-c-step-claimed", step);
    return { ...step, sequence: receipt.sequence };
  }
  async end(step: ClaudeStep) {
    await this.#storage.transaction(async (tx) => {
      const active = await tx.get<ClaudeStep>("claude/active-step");
      assert(
        active?.variant === step.variant &&
          active.requestId === step.requestId &&
          active.phase === step.phase,
        "Claude C step release does not match the active public request",
      );
      await tx.delete("claude/active-step");
    });
    const receipt = await this.#owner.append("claude-public-c-step-ended", step);
    return { ...step, sequence: receipt.sequence };
  }
  private async openModel(variant: ClaudeVariant) {
    const claim = `claude/model/${variant}/owner`;
    assert(!(await this.#storage.get(claim)), "Claude model owner reset; replay is forbidden");
    const config = await this.#owner.config();
    const workload = config.claude.runtime.workload;
    await this.#storage.put(claim, {
      collectorNonce: workload.collectorNonce,
      model: workload.model,
    });
    const peer = new ClaudeQualificationModelPeer(workload);
    const transport = createClaudeWorkloadTransport({
      ...workload,
      fetch: (request) => peer.fetch(request),
      modelEvidence: () => peer.snapshot(),
      record: async (record, wire) => {
        const step = await this.active();
        assert(step?.variant === variant, "Claude model record lost its public C owner");
        const artifact = wire
          ? await this.#owner.artifact(
              `claude-${variant}-model-${record.ordinal}-${record.phase}`,
              wire,
            )
          : undefined;
        const value = {
          ...record,
          variant,
          runId: claudeLane(config.runId, variant).runId,
          publicRequestId: step.requestId,
          workflowPhase: step.phase,
          ...(artifact ? { artifact } : {}),
        };
        const appended = await this.#owner.append("claude-model-wire", value);
        await this.#storage.put(
          `claude/model/${variant}/record/${String(record.ordinal).padStart(10, "0")}/${record.phase}`,
          { ...value, sequence: appended.sequence },
        );
      },
    });
    return { peer, transport };
  }
  async request(request: Request) {
    const step = await this.active();
    assert(step, "Claude model request has no active public C step");
    const failure = `claude/model/${step.variant}/failure`;
    assert(
      !(await this.#storage.get(failure)),
      "Claude model's first failure forbids another request",
    );
    let model = this.#models.get(step.variant);
    if (!model) {
      model = this.openModel(step.variant);
      this.#models.set(step.variant, model);
    }
    try {
      return await (await model).transport(request);
    } catch (cause) {
      await this.#storage.put(failure, errorRecord(cause));
      throw cause;
    }
  }
  async c(variant: ClaudeVariant, phase: ClaudeStepPhase) {
    const config = await this.#owner.config();
    const lane = claudeLane(config.runId, variant);
    return createClaudeCTransport({
      variant,
      configuration: async () => config,
      shard: () => this.#owner.environment().PROCESS_EXECUTION_SHARDS.getByName(lane.shardOwner),
      phaseForRequest: () => phase,
      beginStep: (step) => this.begin(step),
      endStep: (step) => this.end(step),
    });
  }
  async runShard(
    variant: ClaudeVariant,
    phase: ClaudeStepPhase,
    ...args: Parameters<ClaudeCTransport["runShard"]>
  ) {
    return (await this.c(variant, phase)).runShard(...args);
  }
  async resumeProcess(
    variant: ClaudeVariant,
    input: Parameters<ClaudeCTransport["resumeProcess"]>[0],
  ) {
    return (await this.c(variant, "resume")).resumeProcess(input);
  }
  async continueProcess(
    variant: ClaudeVariant,
    phase: ClaudeStepPhase,
    ...args: Parameters<ClaudeCTransport["continueProcess"]>
  ) {
    return (await this.c(variant, phase)).continueProcess(...args);
  }
  async commitProcessCheckpoint(
    variant: ClaudeVariant,
    input: Parameters<ClaudeCTransport["commitProcessCheckpoint"]>[0],
  ) {
    return (await this.c(variant, "work")).commitProcessCheckpoint(input);
  }
  async stopIdleProcess(
    variant: ClaudeVariant,
    input: Parameters<ClaudeCTransport["stopIdleProcess"]>[0],
  ) {
    return (await this.c(variant, "work")).stopIdleProcess(input);
  }
  async snapshot(variant: ClaudeVariant) {
    const model = this.#models.get(variant);
    assert(model, "No retained Claude model owner exists for this variant");
    return (await model).peer.snapshot();
  }
  async records(variant: ClaudeVariant) {
    return [
      ...(
        await this.#storage.list<ClaudePersistedModelRecord>({
          prefix: `claude/model/${variant}/record/`,
        })
      ).values(),
    ];
  }
}
