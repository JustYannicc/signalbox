// @effect-diagnostics nodeBuiltinImport:off - script capture uses an isolated temporary provider home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  NodeId,
  OrchestrationV2ProviderThread,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { RunnerItem, WorkflowStopRequest } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { makeRunnerWorkflows } from "./RunnerWorkflows.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread-one");
const runId = RunId.make("run-one");
const providerThread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ProviderThread))({
  id: "provider-one",
  driver,
  providerInstanceId: "claudeAgent",
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const task = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2Subagent))({
  id: "coordinator",
  threadId,
  runId,
  parentNodeId: "parent",
  origin: "provider_native",
  createdBy: "agent",
  driver,
  providerInstanceId: "claudeAgent",
  providerThreadId: providerThread.id,
  childThreadId: null,
  nativeTaskRef: { driver, nativeId: "native-coordinator", strength: "strong" },
  prompt: "Review",
  title: null,
  model: null,
  status: "running",
  result: null,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  workflow: { phases: [], agents: [], runHandles: { scriptPath: "/workflow/review.js" } },
});
const event = { type: "subagent.updated", driver, subagent: task } satisfies ProviderAdapterV2Event;
const request: WorkflowStopRequest = {
  generation: 2,
  subagentId: task.id,
  runId,
  taskId: "native-coordinator",
};

const setup = (runtime: Pick<ProviderAdapterV2SessionRuntime, "stopTask"> = {}) => {
  const emitted: Array<RunnerItem> = [];
  let contents = "await firstRevision();";
  let reads = 0;
  const workflows = makeRunnerWorkflows(
    (item) =>
      Effect.sync(() => {
        emitted.push(item);
      }),
    (input) =>
      Effect.sync(() => {
        reads++;
        return { ...input, contents, truncated: false };
      }),
  );
  return {
    workflows,
    emitted,
    runtime,
    reads: () => reads,
    replace: () => {
      contents = "await replacement();";
    },
  };
};

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

describe("Runner workflow tasks", () => {
  it.effect(
    "captures real script bytes through the contained reader before the path is reused",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-script-"));
      homes.push(home);
      const directory = NodePath.join(home, ".claude", "projects", "test");
      NodeFS.mkdirSync(directory, { recursive: true });
      const scriptPath = NodePath.join(directory, "review.js");
      NodeFS.writeFileSync(scriptPath, "await original();\n");
      const workflows = makeRunnerWorkflows(() => Effect.void);
      const reporting = {
        ...event,
        subagent: { ...task, workflow: { ...task.workflow!, runHandles: { scriptPath } } },
      };
      return Effect.gen(function* () {
        const first = yield* workflows.observe(reporting, {}, providerThread, runId);
        expect(first.script).toMatchObject({
          scriptPath,
          contents: "await original();\n",
          truncated: false,
        });
        NodeFS.writeFileSync(scriptPath, "await replacement();\n");
        const later = yield* workflows.observe(reporting, {}, providerThread, runId);
        expect(later.script).toBeNull();
        expect(later.event).toMatchObject({
          subagent: { workflow: { runHandles: { scriptRevision: first.script!.revision } } },
        });
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    },
  );

  it.effect("deduplicates an in-flight stop and re-emits the result to both deliveries", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let calls = 0;
      const runtime = {
        stopTask: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(finish)),
          ),
      };
      const fixture = setup(runtime);
      yield* fixture.workflows.observe(event, runtime, providerThread, runId);
      const first = yield* fixture.workflows.stop(request).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const duplicate = yield* fixture.workflows.stop(request).pipe(Effect.forkChild);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(duplicate);
      expect(calls).toBe(1);
      expect(fixture.emitted).toHaveLength(2);
    }),
  );

  it.effect("replays a failed result and executes an explicit retry with a fresh attempt", () =>
    Effect.gen(function* () {
      let calls = 0;
      const runtime = {
        stopTask: () =>
          Effect.suspend(() => (++calls === 1 ? Effect.die("stop failed") : Effect.void)),
      };
      const fixture = setup(runtime);
      yield* fixture.workflows.observe(event, runtime, providerThread, runId);
      yield* fixture.workflows.stop({ ...request, attempt: 1 });
      yield* fixture.workflows.stop({ ...request, attempt: 1 });
      expect(calls).toBe(1);
      expect(fixture.emitted).toEqual(
        Array.from({ length: 2 }, () => ({
          kind: "workflow.stopped",
          ...request,
          attempt: 1,
          ok: false,
        })),
      );
      yield* fixture.workflows.stop({ ...request, attempt: 2 });
      expect(calls).toBe(2);
      expect(fixture.emitted[2]).toMatchObject({ attempt: 2, ok: true });
    }),
  );

  it.effect("re-emits a cached success after its first result delivery failed", () =>
    Effect.gen(function* () {
      let calls = 0;
      let deliveries = 0;
      const emitted: Array<RunnerItem> = [];
      const workflows = makeRunnerWorkflows((item) =>
        Effect.sync(() => {
          if (++deliveries === 1) throw new Error("lost result");
          emitted.push(item);
        }),
      );
      const runtime = {
        stopTask: () =>
          Effect.sync(() => {
            calls++;
          }),
      };
      yield* workflows.observe(
        { ...event, subagent: { ...task, workflow: { phases: [], agents: [] } } },
        runtime,
        providerThread,
        runId,
      );
      yield* workflows.stop(request).pipe(Effect.exit);
      yield* workflows.stop(request);
      expect(calls).toBe(1);
      expect(emitted).toEqual([{ kind: "workflow.stopped", ...request, ok: true }]);
    }),
  );

  it.effect(
    "retains the first script revision and never reads a reused path for that coordinator",
    () =>
      Effect.gen(function* () {
        const fixture = setup();
        const first = yield* fixture.workflows.observe(event, {}, providerThread, runId);
        expect(first.script?.contents).toBe("await firstRevision();");
        expect(first.script?.revision).toMatch(/^[0-9a-f]{64}$/);
        fixture.replace();
        const later = yield* fixture.workflows.observe(event, {}, providerThread, runId);
        expect(later.script).toBeNull();
        expect(later.event).toMatchObject({
          subagent: { workflow: { runHandles: { scriptRevision: first.script!.revision } } },
        });
        expect(fixture.reads()).toBe(1);
        const sibling = yield* fixture.workflows.observe(
          { ...event, subagent: { ...task, id: NodeId.make("sibling") } },
          {},
          providerThread,
          runId,
        );
        expect(sibling.script?.contents).toBe("await replacement();");
        expect(sibling.script?.revision).not.toBe(first.script?.revision);
      }),
  );

  it.effect("stops only the observed native coordinator once, through stopTask", () =>
    Effect.gen(function* () {
      const stopped: Array<string> = [];
      const runtime = {
        stopTask: ({ taskId }: { readonly taskId: string }) =>
          Effect.sync(() => {
            stopped.push(taskId);
          }),
      };
      const fixture = setup(runtime);
      yield* fixture.workflows.observe(event, runtime, providerThread, runId);
      yield* fixture.workflows.stop(request);
      yield* fixture.workflows.stop(request);
      expect(stopped).toEqual(["native-coordinator"]);
      expect(fixture.emitted).toEqual(
        Array.from({ length: 2 }, () => ({ kind: "workflow.stopped", ...request, ok: true })),
      );
    }),
  );

  it.effect(
    "refuses unknown tasks, wrong runs, wrong native ids, foreign provider threads and unsupported runtimes",
    () =>
      Effect.gen(function* () {
        const stopped: Array<string> = [];
        const runtime = {
          stopTask: ({ taskId }: { readonly taskId: string }) =>
            Effect.sync(() => {
              stopped.push(taskId);
            }),
        };
        const fixture = setup(runtime);
        yield* fixture.workflows.observe(event, runtime, providerThread, runId);
        for (const wrong of [
          { ...request, subagentId: NodeId.make("parent") },
          { ...request, runId: RunId.make("other") },
          { ...request, taskId: "native-sibling" },
        ])
          yield* fixture.workflows.stop(wrong);
        expect(stopped).toEqual([]);
        expect(fixture.emitted.every((item) => item.kind === "workflow.stopped" && !item.ok)).toBe(
          true,
        );
        const foreign = setup(runtime);
        yield* foreign.workflows.observe(
          event,
          runtime,
          { ...providerThread, id: ProviderThreadId.make("other-provider") },
          runId,
        );
        yield* foreign.workflows.stop(request);
        const unsupported = setup();
        yield* unsupported.workflows.observe(event, {}, providerThread, runId);
        yield* unsupported.workflows.stop(request);
        expect(stopped).toEqual([]);
        expect(foreign.emitted[0]).toMatchObject({ ok: false });
        expect(unsupported.emitted[0]).toMatchObject({ ok: false });
      }),
  );
});
