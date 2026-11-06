import { launchPreparedNodeHarnessProcess } from "./lifetime.ts";
import { createHarnessRuntime } from "./runtime.ts";
import type { NodeHarnessProcessInput } from "./types.ts";

export function launchNodeHarnessProcess(input: NodeHarnessProcessInput) {
  return launchPreparedNodeHarnessProcess(
    {
      ...input,
      stdio: {
        ...input.stdio,
        assertBound(files) {
          if (files !== input.computer.files)
            throw new Error("Node process changed its filesystem");
          input.stdio.assertBound(input.computer.files);
        },
      },
    },
    (processInput, signals, onChild, bridge) =>
      createHarnessRuntime(
        {
          ...input,
          ...processInput,
          computer: input.computer,
          stdio: input.stdio,
        },
        signals,
        onChild,
        bridge,
      ),
  );
}
