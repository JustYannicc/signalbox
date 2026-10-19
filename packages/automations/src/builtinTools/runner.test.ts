import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeBuiltinTools, type BuiltinToolCall, type BuiltinToolHandler } from "./runner.ts";

const callFor = (tool: string, args: unknown): Omit<BuiltinToolCall, "tool"> => ({
  args,
  automationId: "automation-1",
  projectId: "project-a",
  runId: "run-1",
  automationName: "Test automation",
  runtimeMode: "auto",
  requestKey: "step-1",
});

const makeTools = (
  approval: "signalbox" | "person" | "agent" | null,
  threadProject: string | undefined = "project-a",
) =>
  makeBuiltinTools({
    approvalOf: () => Effect.succeed(approval),
    projectOfThread: () => Effect.succeed(threadProject),
  });

describe("built-in tool security policies", () => {
  it.effect("requires a published version for protected run-scoped tools", () =>
    Effect.gen(function* () {
      const tools = makeTools("agent");
      let called = false;
      yield* tools.register({
        tools: ["github_issue"],
        policies: { github_issue: { requiresVouch: true, projectScope: "run" } },
        call: () =>
          Effect.sync(() => {
            called = true;
            return "created";
          }),
      });

      const result = yield* Effect.result(
        tools.call("signalbox.github_issue", callFor("github_issue", {})),
      );
      expect(result._tag).toBe("Failure");
      expect(called).toBe(false);
      if (result._tag === "Failure")
        expect(result.failure.message).not.toContain("merge_pull_request");
    }),
  );

  it.effect("keeps run-scoped operations on the run project", () =>
    Effect.gen(function* () {
      let threadLookupCount = 0;
      const tools = makeBuiltinTools({
        approvalOf: () => Effect.succeed("person"),
        projectOfThread: () => {
          threadLookupCount += 1;
          return Effect.succeed("project-b");
        },
      });
      yield* tools.register({
        tools: ["github_workflow"],
        policies: { github_workflow: { requiresVouch: true, projectScope: "run" } },
        call: (input) => Effect.succeed(input.projectId),
      });

      expect(yield* tools.call("signalbox.github_workflow", callFor("github_workflow", {}))).toBe(
        "project-a",
      );
      expect(threadLookupCount).toBe(0);
    }),
  );

  it.effect("keeps pull request actions vouched and limited to their thread project", () =>
    Effect.gen(function* () {
      let called = false;
      const handler = {
        tools: ["pull_request_action"],
        policies: {
          pull_request_action: { requiresVouch: true, projectScope: "thread" },
        },
        call: () =>
          Effect.sync(() => {
            called = true;
            return "merged";
          }),
      } satisfies BuiltinToolHandler;
      const unvouched = makeTools("agent");
      yield* unvouched.register(handler);

      const vouchResult = yield* Effect.result(
        unvouched.call(
          "signalbox.pull_request_action",
          callFor("pull_request_action", { threadId: "thread-1", action: "merge" }),
        ),
      );
      expect(vouchResult._tag).toBe("Failure");

      const wrongProject = makeTools("person", "project-b");
      yield* wrongProject.register(handler);
      const scopeResult = yield* Effect.result(
        wrongProject.call(
          "signalbox.pull_request_action",
          callFor("pull_request_action", { threadId: "thread-1", action: "merge" }),
        ),
      );
      expect(scopeResult._tag).toBe("Failure");
      expect(called).toBe(false);
    }),
  );

  it.effect("preserves task lifecycle protection and accepts older handlers without policies", () =>
    Effect.gen(function* () {
      const tools = makeTools("agent");
      let lifecycleCalled = false;
      yield* tools.register({
        tools: ["task_lifecycle"],
        call: () =>
          Effect.sync(() => {
            lifecycleCalled = true;
            return "updated";
          }),
      });
      const denied = yield* Effect.result(
        tools.call(
          "signalbox.task_lifecycle",
          callFor("task_lifecycle", { action: "archive", threadId: "thread-1" }),
        ),
      );
      expect(denied._tag).toBe("Failure");
      expect(lifecycleCalled).toBe(false);

      let legacyCalled = false;
      yield* tools.register({
        tools: ["legacy_tool"],
        call: () =>
          Effect.sync(() => {
            legacyCalled = true;
            return "ok";
          }),
      } satisfies BuiltinToolHandler);
      expect(yield* tools.call("signalbox.legacy_tool", callFor("legacy_tool", {}))).toBe("ok");
      expect(legacyCalled).toBe(true);
    }),
  );
});
