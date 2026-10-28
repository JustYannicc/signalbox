import { DurableObject } from "cloudflare:workers";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "./processPlacement/execution.ts";
import { HarnessProcessResumeOwner } from "./processResume/owner.ts";
import { ProcessIncarnation, processContext } from "./processOwnership/incarnation.ts";
import { createProcessStoreBindings } from "./processOwnership/bindings.ts";
import type { HarnessDurableStateBindings } from "./HarnessDurableState.ts";

/** The C owner keeps the real DO context and lifecycle state behind this transport. */
export class HarnessProcessExecutionShardObject extends DurableObject<HarnessProcessExecutionEnvironment> {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - the platform constructor creates the shard incarnation before its request runtime.
  readonly #executionIncarnationNonce = crypto.randomUUID();
  readonly #incarnation;
  readonly #processStores;
  readonly #ready;
  #resumeOwner: HarnessProcessResumeOwner | undefined;

  constructor(ctx: DurableObjectState, env: HarnessProcessExecutionEnvironment) {
    super(ctx, env);
    this.#incarnation = new ProcessIncarnation(
      ctx.storage,
      ctx.id.name ?? ctx.id.toString(),
      this.#executionIncarnationNonce,
    );
    this.#processStores = createProcessStoreBindings(
      env as HarnessProcessExecutionEnvironment & Partial<HarnessDurableStateBindings>,
      this.#incarnation,
      ctx,
    );
    this.#ready = ctx.blockConcurrencyWhile(() =>
      this.#incarnation.activateRuns(this.#processStores.activate),
    );
  }

  async executionIncarnationNonce() {
    await this.#ready;
    await this.#incarnation.assertCurrent();
    return this.#executionIncarnationNonce;
  }

  async processIncarnationFence() {
    await this.#ready;
    return this.#incarnation.assertCurrent();
  }

  protected processExecutionHooks(): HarnessProcessExecutionHooks | undefined {
    return undefined;
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult> {
    await this.#ready;
    await this.#incarnation.activateRun(input.runId);
    return this.#owner().runShard(input, requestContextId, this.processExecutionHooks());
  }

  async startFreshProcess(input: Parameters<HarnessProcessResumeOwner["startFreshProcess"]>[0]) {
    await this.#ready;
    await this.#incarnation.activateRun(input.runId);
    return this.#owner().startFreshProcess(input);
  }

  async runCreatedProcess(
    input: Parameters<HarnessProcessResumeOwner["runCreatedProcess"]>[0],
    requestContextId: string,
  ) {
    await this.#ready;
    await this.#incarnation.activateRun(input.runId);
    return this.#owner().runCreatedProcess(input, requestContextId);
  }

  async recoverFreshProcess(
    input: Parameters<HarnessProcessResumeOwner["recoverFreshProcess"]>[0],
  ) {
    await this.#ready;
    await this.#incarnation.activateRun(input.runId);
    return this.#owner().recoverFreshProcess(input);
  }

  processCreationStatus(input: Parameters<HarnessProcessResumeOwner["processCreationStatus"]>[0]) {
    return this.#owner().processCreationStatus(input);
  }

  resumeProcess(operation: unknown) {
    return this.#owner().resumeProcess(operation);
  }

  commitProcessCheckpoint(input: unknown) {
    return this.#owner().commitProcessCheckpoint(input);
  }

  continueProcess(input: unknown, requestContextId: string) {
    return this.#owner().continueProcess(input, requestContextId);
  }

  stopIdleProcess(input: unknown) {
    return this.#owner().stopIdleProcess(input);
  }

  cancelResumeProcess(input: unknown) {
    return this.#owner().cancelResumeProcess(input);
  }

  processResumeStatus(input: Parameters<HarnessProcessResumeOwner["processResumeStatus"]>[0]) {
    return this.#owner().processResumeStatus(input);
  }

  #owner() {
    return (this.#resumeOwner ??= new HarnessProcessResumeOwner(
      processContext(this.ctx, this.#incarnation),
      { ...this.env, HARNESS_C_PROCESS_STORES: this.#processStores },
      this.#executionIncarnationNonce,
      this.#incarnation,
    ));
  }
}
