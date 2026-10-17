import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { v2ShellSnapshot, v2ThreadId, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";

const environmentId = EnvironmentId.make("environment-lifecycle");

describe("optimistic thread lifecycle", () => {
  it("ends a settle preview once the task leaves the live shell, so a reopen shows as active", async () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot).pipe(
      Atom.keepAlive,
    );
    const lifecycle = createOptimisticThreadLifecycle(() => source);
    // Cloud commands answer with the thread's own event number, far above the shell's counter.
    const settle = lifecycle.wrap(
      { label: "settle", run: async () => AsyncResult.success({ sequence: 1_000 }) },
      (thread, _input, now) => ({ ...thread, settledOverride: "settled", settledAt: now }),
    );
    const shown = () =>
      registry.get(lifecycle.snapshotAtom(environmentId))?.threads[0]?.settledOverride;

    await settle.run(registry, { environmentId, input: { threadId: v2ThreadId } });
    expect(shown()).toBe("settled");

    // Settling archives the task: it leaves the live shell.
    registry.set(source, { ...v2ShellSnapshot, snapshotSequence: 1, threads: [] });
    // Reopening brings it back, still far below the command's sequence.
    registry.set(source, {
      ...v2ShellSnapshot,
      snapshotSequence: 2,
      threads: [{ ...v2ThreadShell, settledOverride: "active" }],
    });
    expect(shown()).toBe("active");
  });
});
