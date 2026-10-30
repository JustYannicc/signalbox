import type { QualifierProof } from "./proof.ts";
import { ClaudeLifecycle } from "./claudeLifecycle.ts";
import type { ClaudeVariant } from "./claudeScenario.ts";
import { assert, errorRecord } from "./common.ts";

export const CLAUDE_STEPS = ["turn-1", "replace", "turn-2", "turn-3", "finish"] as const;
export type ClaudeDispatchStep = (typeof CLAUDE_STEPS)[number];
export interface ClaudeStepReceipt {
  readonly schema: "signalbox/claude-qualification-step/v1";
  readonly runId: string;
  readonly variant: ClaudeVariant;
  readonly step: ClaudeDispatchStep;
  readonly status: "completed" | "failed";
  readonly result?: unknown;
  readonly failure?: unknown;
}

/** Durable one-shot claims prevent a receipt read or an owner reset from replaying native work. */
export class ClaudeDispatch {
  readonly #owner: QualifierProof;
  readonly #storage: DurableObjectStorage;
  readonly #incarnation: string;
  readonly #lifecycles: Record<ClaudeVariant, ClaudeLifecycle>;
  readonly #pending = new Map<string, Promise<ClaudeStepReceipt>>();
  constructor(owner: QualifierProof, storage: DurableObjectStorage, incarnation: string) {
    this.#owner = owner;
    this.#storage = storage;
    this.#incarnation = incarnation;
    this.#lifecycles = {
      baseline: new ClaudeLifecycle(owner, "baseline"),
      hooks: new ClaudeLifecycle(owner, "hooks"),
    };
  }
  async dispatch(variant: ClaudeVariant, step: ClaudeDispatchStep) {
    const key = `claude/dispatch/${variant}/${step}`;
    assert(await this.#storage.get("ready"), "Readiness must precede Claude native dispatch");
    assert(
      await this.#storage.get("observer/calibration"),
      "Exact-build calibration must precede Claude native dispatch",
    );
    const index = CLAUDE_STEPS.indexOf(step);
    assert(index >= 0, "Unknown Claude qualifier step");
    if (index > 0) {
      const prior = await this.receipt(variant, CLAUDE_STEPS[index - 1]!);
      assert(prior.status === "completed", "The previous Claude qualifier step did not complete");
    }
    await this.#storage.transaction(async (tx) => {
      assert(
        !(await tx.get(`${key}/claim`)),
        "This Claude native step was already claimed; do not resubmit it",
      );
      const ownerKey = `claude/dispatch/${variant}/owner`;
      const owner = await tx.get(ownerKey);
      if (step === "turn-1") {
        assert(owner === undefined, "Claude native creation was already claimed");
        await tx.put(ownerKey, this.#incarnation);
      } else
        assert(owner === this.#incarnation, "Claude execution owner reset; replay is forbidden");
      await tx.put(`${key}/claim`, { incarnation: this.#incarnation });
    });
    await this.#owner.append("claude-step-claimed", {
      variant,
      step,
      incarnation: this.#incarnation,
    });
    const pending = this.run(variant, step);
    this.#pending.set(key, pending);
    return { claimed: true, runId: (await this.#owner.config()).runId, variant, step };
  }
  private async run(variant: ClaudeVariant, step: ClaudeDispatchStep): Promise<ClaudeStepReceipt> {
    const identity = {
      schema: "signalbox/claude-qualification-step/v1" as const,
      runId: (await this.#owner.config()).runId,
      variant,
      step,
    };
    let receipt: ClaudeStepReceipt;
    try {
      const lifecycle = this.#lifecycles[variant];
      const result =
        step === "replace"
          ? await lifecycle.replace()
          : step === "finish"
            ? await lifecycle.finish()
            : await lifecycle.turn(Number(step.slice(-1)) as 1 | 2 | 3);
      receipt = { ...identity, status: "completed", result };
    } catch (cause) {
      receipt = { ...identity, status: "failed", failure: errorRecord(cause) };
    }
    await this.#owner.saveState(`claude-${variant}-step-${step}`, receipt);
    await this.#storage.put(`claude/dispatch/${variant}/${step}/receipt`, true);
    return receipt;
  }
  async receipt(variant: ClaudeVariant, step: ClaudeDispatchStep): Promise<ClaudeStepReceipt> {
    const key = `claude/dispatch/${variant}/${step}`;
    if (await this.#storage.get(`${key}/receipt`))
      return await this.#owner.state<ClaudeStepReceipt>(`claude-${variant}-step-${step}`);
    const pending = this.#pending.get(key);
    assert(
      pending,
      "Claude step is unstarted or its owner reset; a missing receipt never permits replay",
    );
    return await pending;
  }
  pending(variant: ClaudeVariant, step: ClaudeDispatchStep) {
    const pending = this.#pending.get(`claude/dispatch/${variant}/${step}`);
    assert(pending, "Claude dispatch has no owned pending operation");
    return pending;
  }
}
