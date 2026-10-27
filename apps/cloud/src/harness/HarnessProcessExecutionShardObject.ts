import { DurableObject } from "cloudflare:workers";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "./processPlacement/execution.ts";
import { HarnessProcessResumeOwner } from "./processResume/owner.ts";

/** The C owner keeps the real DO context and lifecycle state behind this transport. */
export class HarnessProcessExecutionShardObject extends DurableObject<HarnessProcessExecutionEnvironment> {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - the platform constructor creates the shard incarnation before its request runtime.
  readonly #executionIncarnationNonce = crypto.randomUUID();
  #resumeOwner: HarnessProcessResumeOwner | undefined;

  executionIncarnationNonce() {
    return this.#executionIncarnationNonce;
  }

  protected processExecutionHooks(): HarnessProcessExecutionHooks | undefined {
    return undefined;
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult> {
    return this.#owner().runShard(input, requestContextId, this.processExecutionHooks());
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
      this.ctx,
      this.env,
      this.#executionIncarnationNonce,
    ));
  }
}
