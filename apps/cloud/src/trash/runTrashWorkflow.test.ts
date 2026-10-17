import { expect, it } from "@effect/vitest";

import { runTrashWorkflow } from "./runTrashWorkflow.ts";

it("journals retries and sleeps until the cascade confirms completion", async () => {
  const steps: string[] = [];
  const deadlines: number[] = [];
  let calls = 0;
  await runTrashWorkflow(
    {
      do: async (name, operation) => {
        steps.push(name);
        return operation();
      },
      sleepUntil: async (name, deadline) => {
        steps.push(name);
        deadlines.push(deadline.getTime());
      },
    },
    async () => {
      calls++;
      if (calls === 1) throw new Error("The object was evicted before replying.");
      return calls === 2 ? { done: false, nextAt: 123_456 } : { done: true, nextAt: 123_457 };
    },
  );
  expect(calls).toBe(3);
  expect(steps).toEqual(["cascade-0", "wait-0", "cascade-1", "wait-1", "cascade-2"]);
  expect(deadlines[0]).toBeGreaterThan(0);
  expect(deadlines[1]).toBe(123_456);
});
