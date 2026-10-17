import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  claudeModelSelection,
  connectModelPool,
  makeModelStepHarness,
  promptOf,
} from "./modelStepTesting.ts";

const providerAndModel = {
  claude: 'provider: "claudeAgent", model: "claude-sonnet-5-5"',
  codex: 'provider: "codex", model: "gpt-6.1-sol"',
} as const;

const forbiddenRequestFields = new Set([
  "tools",
  "workspace",
  "harness",
  "permission",
  "permissions",
  "permissionMode",
  "runtimeMode",
  "interactionMode",
  "provider",
  "providerInstanceId",
]);

const allFieldNames = (value: unknown): Array<string> => {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allFieldNames(child)]);
};

describe("cloud model steps", () => {
  it.effect("runs text, both judge forms and nested extraction through each pool gateway", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude", "codex"], (request) => {
        const prompt = promptOf(request);
        if (prompt.includes("Summarize the Claude release")) return { text: "Claude summary" };
        if (prompt.includes("Summarize the Codex issue")) return { text: "Codex summary" };
        if (prompt.includes("Bug or noise?")) return { text: "bug" };
        if (prompt.includes("Is the release ready?"))
          return { text: '{"verdict":true,"reason":"The checks passed."}' };
        if (prompt.includes("Extract the following"))
          return {
            text: '{"checks":[{"count":3,"active":true},{"count":5,"active":false}],"ratio":0.75}',
          };
        return { text: "No matching fixture reply." };
      });
      const automation =
        yield* harness.save(`export const meta = { name: "Cloud model steps" } as const;
export default workflow(async (w) => {
  const claude = await w.llm("Claude summary", { prompt: "Summarize the Claude release" });
  const codex = await w.llm("Codex summary", { prompt: "Summarize the Codex issue", ${providerAndModel.codex} });
  const legacy = await w.judge("Bug or noise?", { input: "Login crashes", outcomes: ["bug", "noise"], ${providerAndModel.claude} });
  const verdict = await w.judge("Is the release ready?", { input: "All checks passed", ${providerAndModel.codex}, retry: { attempts: 1 } });
  const extracted = await w.extract("Release checks", { input: "Three active checks and five inactive checks", schema: { checks: [{ count: "number", active: "boolean" }], ratio: "number" }, ${providerAndModel.claude} });
  return { claude, codex, legacy, verdict, extracted };
});`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("succeeded");
      expect(done.output).toEqual({
        claude: "Claude summary",
        codex: "Codex summary",
        legacy: "bug",
        verdict: { verdict: true, reason: "The checks passed." },
        extracted: {
          checks: [
            { count: 3, active: true },
            { count: 5, active: false },
          ],
          ratio: 0.75,
        },
      });
      expect(done.steps.map((step) => [step.status, step.threadId])).toEqual(
        Array.from({ length: 5 }, () => ["succeeded", null]),
      );
      expect(gateway.requests.map(({ path, body }) => [path, body.model])).toEqual([
        ["/v1/messages", claudeModelSelection.model],
        ["/v1/responses", "gpt-6.1-sol"],
        ["/v1/messages", claudeModelSelection.model],
        ["/v1/responses", "gpt-6.1-sol"],
        ["/v1/messages", claudeModelSelection.model],
      ]);
      for (const request of gateway.requests) {
        expect(
          [...forbiddenRequestFields].filter((field) =>
            allFieldNames(request.body).includes(field),
          ),
        ).toEqual([]);
      }
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("retries invalid default judge and extract answers through the gateway", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      let judgeRequests = 0;
      let extractRequests = 0;
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], (request) => {
        const prompt = promptOf(request);
        if (prompt.includes("Is this ready?")) {
          judgeRequests += 1;
          return {
            text:
              judgeRequests === 1
                ? '{"verdict":"yes","reason":"The checks passed."}'
                : '{"verdict":true,"reason":"The checks passed."}',
          };
        }
        extractRequests += 1;
        return {
          text:
            extractRequests === 1
              ? '{"checks":[{"count":"3","active":true}]}'
              : '{"checks":[{"count":3,"active":true}]}',
        };
      });
      const automation =
        yield* harness.save(`export const meta = { name: "Retry parsed answers" } as const;
export default workflow(async (w) => {
  const verdict = await w.judge("Is this ready?", { input: "The checks passed" });
  const extracted = await w.extract("Read checks", {
    input: "Three active checks",
    schema: { checks: [{ count: "number", active: "boolean" }] },
  });
  return { verdict, extracted };
});`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("succeeded");
      expect(done.output).toEqual({
        verdict: { verdict: true, reason: "The checks passed." },
        extracted: { checks: [{ count: 3, active: true }] },
      });
      expect(gateway.requests).toHaveLength(4);
      expect([judgeRequests, extractRequests]).toEqual([2, 2]);
      expect(done.steps.map((step) => [step.status, step.threadId])).toEqual([
        ["succeeded", null],
        ["succeeded", null],
      ]);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("fails nested extraction that does not match its declared schema", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], () => ({
        text: '{"checks":[{"count":"3","active":true}]}',
      }));
      const automation =
        yield* harness.save(`export const meta = { name: "Invalid extraction" } as const;
export default workflow(async (w) => await w.extract("Read checks", {
  input: "Three active checks",
  schema: { checks: [{ count: "number", active: "boolean" }] },
  ${providerAndModel.claude},
  retry: { attempts: 1 },
}));`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("failed");
      expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
      expect(done.steps[0]?.error).toContain("doesn't match the extraction schema");
      expect(gateway.requests).toHaveLength(1);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("fails a malformed no-outcomes judge verdict or empty reason", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], () => ({ text: "" }));
      const automation =
        yield* harness.save(`export const meta = { name: "Invalid judge" } as const;
export default workflow(async (w) => await w.judge("Is this ready?", {
  input: "Checks are incomplete",
  ${providerAndModel.claude},
  retry: { attempts: 1 },
}));`);

      for (const text of [
        '{"verdict":"yes","reason":"The checks passed."}',
        '{"verdict":true,"reason":"   "}',
      ]) {
        gateway.setResponder(() => ({ text }));
        const done = yield* harness.startAndWait(automation.id);
        expect(done.run.status).toBe("failed");
        expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
        expect(done.steps[0]?.error).toContain("boolean verdict and a reason");
      }

      expect(gateway.requests).toHaveLength(2);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("stops after two invalid parse attempts without sleeping", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], () => ({
        text: '{"verdict":"yes","reason":"The checks passed."}',
      }));
      const automation =
        yield* harness.save(`export const meta = { name: "Exhausted judge retries" } as const;
export default workflow(async (w) => await w.judge("Is this ready?", {
  input: "Checks are incomplete",
  retry: { attempts: 2 },
}));`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("failed");
      expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
      expect(done.steps[0]?.error).toContain("boolean verdict and a reason");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests.map(({ path, body }) => [path, body.model])).toEqual([
        ["/v1/messages", claudeModelSelection.model],
        ["/v1/messages", claudeModelSelection.model],
      ]);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("fails when its current project has no pool, without starting a thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const automation = yield* harness.save(`export const meta = { name: "Missing pool" } as const;
export default workflow(async (w) => await w.llm("Summarize", {
  prompt: "Use the project's current pool",
  ${providerAndModel.claude},
}));`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("failed");
      expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
      expect(done.steps[0]?.error).toContain("pool");
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("refuses an unknown or removed project instead of using Personal", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], () => ({
        text: "This must not be requested",
      }));
      const automation = yield* harness.save(
        `export const meta = { name: "Removed project" } as const;
export default workflow(async (w) => await w.llm("Summarize", {
  prompt: "Use the project's current pool",
  ${providerAndModel.claude},
}));`,
        ProjectId.make("removed-project"),
      );

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("failed");
      expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
      expect(done.steps[0]?.error).toContain("no longer have access to this folder");
      expect(gateway.requests).toEqual([]);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );

  it.effect("reports an unavailable pool upstream as a failed step without thread fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeModelStepHarness();
      const { gateway } = yield* connectModelPool(harness.cloud, ["claude"], () => ({
        text: "unavailable",
        status: 503,
      }));
      const automation =
        yield* harness.save(`export const meta = { name: "Unavailable model" } as const;
export default workflow(async (w) => await w.llm("Summarize", {
  prompt: "Summarize the unavailable provider response",
  ${providerAndModel.claude},
}));`);

      const done = yield* harness.startAndWait(automation.id);

      expect(done.run.status).toBe("failed");
      expect(done.steps[0]).toMatchObject({ status: "failed", threadId: null });
      expect(done.steps[0]?.error).toContain("HTTP 503");
      expect(gateway.requests.map((request) => request.path)).toEqual(["/v1/messages"]);
      expect(yield* harness.threadProjectionIds()).toEqual([]);
    }),
  );
});
