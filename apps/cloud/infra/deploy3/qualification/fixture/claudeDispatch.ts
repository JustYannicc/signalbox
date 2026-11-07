import { readRpcData, withRpcStub } from "../../../../src/rpc/Resources.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";
import { assert, errorRecord } from "./common.ts";

/** Native commands that arrive while the thread step runs belong to this route. */
export const CLAUDE_THREAD_ROUTE = "/claude/thread/dispatch";
export const CLAUDE_THREAD_RECEIPT_ROUTE = "/claude/thread/receipt";
const ACTIVE = "claude/thread/active";
export interface ClaudeThreadReceipt {
  readonly schema: "signalbox/claude-qualification-thread/v1";
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly result?: unknown;
  readonly failure?: unknown;
}

/**
 * The qualifier's Claude step: both turns on the product's thread host, claimed once. A receipt
 * read or an owner reset never replays native work.
 */
export class ClaudeDispatch {
  readonly #owner: QualifierExecutionContext;
  readonly #storage: DurableObjectStorage;
  readonly #incarnation: string;
  #pending: Promise<ClaudeThreadReceipt> | undefined;
  constructor(
    owner: QualifierExecutionContext,
    storage: DurableObjectStorage,
    incarnation: string,
  ) {
    this.#owner = owner;
    this.#storage = storage;
    this.#incarnation = incarnation;
  }
  async active() {
    return (await this.#storage.get<boolean>(ACTIVE)) === true;
  }
  async dispatch() {
    assert(await this.#storage.get("ready"), "Readiness must precede Claude native dispatch");
    assert(
      await this.#storage.get("observer/claude-calibration"),
      "The Claude observer calibration must precede Claude native dispatch",
    );
    await this.#storage.transaction(async (tx) => {
      assert(
        !(await tx.get("claude/thread/claim")),
        "The Claude thread step was already claimed; do not resubmit it",
      );
      await tx.put("claude/thread/claim", { incarnation: this.#incarnation });
      await tx.put(ACTIVE, true);
    });
    await this.#owner.append("claude-thread-claimed", { incarnation: this.#incarnation });
    this.#pending = this.run();
    return { claimed: true, runId: (await this.#owner.config()).runId };
  }
  private async run(): Promise<ClaudeThreadReceipt> {
    const runId = (await this.#owner.config()).runId;
    const identity = { schema: "signalbox/claude-qualification-thread/v1" as const, runId };
    let receipt: ClaudeThreadReceipt;
    try {
      const shards = this.#owner.environment().PROCESS_EXECUTION_SHARDS;
      const result = await withRpcStub(shards.getByName(`claude-thread/${runId}`), (shard) =>
        readRpcData(shard.claudeThreadTurns()),
      );
      receipt = { ...identity, status: result.completed ? "completed" : "failed", result };
    } catch (cause) {
      receipt = { ...identity, status: "failed", failure: errorRecord(cause) };
    }
    await this.#owner.saveState("claude-thread", receipt);
    await this.#storage.put("claude/thread/receipt", true);
    await this.#storage.delete(ACTIVE);
    return receipt;
  }
  async receipt(): Promise<ClaudeThreadReceipt> {
    if (await this.#storage.get("claude/thread/receipt"))
      return await this.#owner.state<ClaudeThreadReceipt>("claude-thread");
    assert(
      this.#pending,
      "The Claude thread step is unstarted or its owner reset; a missing receipt never permits replay",
    );
    return await this.#pending;
  }
  pending() {
    assert(this.#pending, "Claude dispatch has no owned pending operation");
    return this.#pending;
  }
}
