import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AUTOMATION_WS_METHODS,
  EnvironmentId,
  ProjectId,
  type ModelSelection,
  WS_METHODS,
} from "@t3tools/contracts";
import { AutomationThreads } from "@signalbox/automations/host";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { makeAutomationHandlers } from "./automationRpc.ts";
import type { CloudSourceCompiler } from "./cloudCompiler.ts";

const userId = "user_automation_rpc";

type Resolver = (projectId?: ProjectId) => Effect.Effect<ModelSelection | null>;
type Handlers = Effect.Success<ReturnType<typeof makeAutomationHandlers>>;

const setup = (automationCompiler?: CloudSourceCompiler) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud(automationCompiler === undefined ? {} : { automationCompiler });
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    return cloud;
  });
type Cloud = Effect.Success<ReturnType<typeof setup>>;

const settingsClient = (cloud: Cloud) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity: {
            environmentId: EnvironmentId.make("cloud-test"),
            label: "Cloud",
            scripted: true,
          },
          userId,
          sid: "automation-rpc-test",
          via: "client",
        }),
        CloudRpc.layerScopeAuthorization([AuthOrchestrationReadScope, AuthSettingsWriteScope]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );

const withHandlers = <A, E>(
  cloud: Cloud,
  newThreadModel: Resolver,
  use: (handlers: Handlers) => Effect.Effect<A, E>,
) =>
  cloud.inUser(
    userId,
    Effect.gen(function* () {
      const handlers = yield* makeAutomationHandlers({
        newThreadModel,
        personReviews: true,
      });
      return yield* use(handlers);
    }),
  );

const compile = (source: string) => {
  const result = compileForCloud(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.compiled;
};

const save = (cloud: Cloud, source: string, newThreadModel: Resolver) =>
  withHandlers(cloud, newThreadModel, (handlers) =>
    handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source,
      projectId: Environment.SCRATCH_PROJECT_ID,
      compiled: compile(source),
    }),
  );

const runNow = (cloud: Cloud, automationId: string, newThreadModel: Resolver) =>
  withHandlers(cloud, newThreadModel, (handlers) =>
    handlers[AUTOMATION_WS_METHODS.automationsRunNow]({ automationId }),
  );

const failIfResolved: Resolver = () => Effect.die("unexpected default-model resolution");

describe("automation RPC model defaults", () => {
  it.effect("validates and saves source-only automation, returning compiler diagnostics", () =>
    Effect.gen(function* () {
      const cloud = yield* setup(async (source) => compileForCloud(source));
      const source = `export const meta = { name: "Compiled in cloud" } as const;
export default workflow(async (w) => "saved");`;
      const validated = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsValidate]({ source }),
      );
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;

      const saved = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsSave]({
          source,
          projectId: Environment.SCRATCH_PROJECT_ID,
        }),
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.graph).toEqual(validated.graph);

      const invalidSource = "export default 1;";
      const invalid = compileForCloud(invalidSource);
      if (invalid.ok) return expect.unreachable();
      const invalidValidation = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsValidate]({ source: invalidSource }),
      );
      const invalidSave = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsSave]({
          source: invalidSource,
          projectId: Environment.SCRATCH_PROJECT_ID,
        }),
      );
      expect(invalidValidation).toEqual({ ok: false, diagnostics: invalid.diagnostics });
      expect(invalidSave).toEqual({ ok: false, diagnostics: invalid.diagnostics });
    }),
  );

  it.effect("keeps accepting caller-compiled validation and save", () =>
    Effect.gen(function* () {
      let compileCalls = 0;
      const cloud = yield* setup(async () => {
        compileCalls += 1;
        return {
          ok: false,
          diagnostics: [{ line: 1, column: 1, message: "The caller should have compiled this." }],
        };
      });
      const source = `export const meta = { name: "Caller compiled" } as const;
export default workflow(async (w) => "saved");`;
      const compiled = compile(source);
      const validated = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsValidate]({ source, compiled }),
      );
      expect(validated.ok).toBe(true);
      const saved = yield* withHandlers(cloud, failIfResolved, (handlers) =>
        handlers[AUTOMATION_WS_METHODS.automationsSave]({
          source,
          projectId: Environment.SCRATCH_PROJECT_ID,
          compiled,
        }),
      );
      expect(saved.ok).toBe(true);
      expect(compileCalls).toBe(0);
    }),
  );

  it.effect("saves and runs a plain workflow when no provider is configured", () =>
    Effect.gen(function* () {
      const cloud = yield* setup();
      const source = `export const meta = { name: "No model needed" } as const;
export default workflow(async (w) => "hello");`;

      const saved = yield* save(cloud, source, failIfResolved);
      if (!saved.ok) return expect.unreachable();
      const started = yield* runNow(cloud, saved.automation.id, failIfResolved);
      yield* cloud.settle;

      const run = yield* cloud.inUser(
        userId,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(started.id)),
      );
      expect([run.run.status, run.output]).toEqual(["succeeded", "hello"]);
    }),
  );

  it.effect("saves and runs an agent step that names its own model", () =>
    Effect.gen(function* () {
      const cloud = yield* setup();
      const source = `export const meta = { name: "Explicit model" } as const;
export default workflow(async (w) => await w.agent("Echo", {
  prompt: "hello",
  provider: "scripted",
  model: "scripted-echo",
}));`;

      const saved = yield* save(cloud, source, failIfResolved);
      if (!saved.ok) return expect.unreachable();
      const started = yield* runNow(cloud, saved.automation.id, failIfResolved);
      yield* cloud.settle;

      const run = yield* cloud.inUser(
        userId,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(started.id)),
      );
      expect(run.run.status).toBe("succeeded");
      expect(run.steps.map((step) => step.verb)).toEqual(["agent"]);
    }),
  );

  it.effect("reports a missing model only when an implicit agent step runs", () =>
    Effect.gen(function* () {
      const cloud = yield* setup();
      const source = `export const meta = { name: "Implicit model" } as const;
export default workflow(async (w) => await w.agent("Echo", { prompt: "hello" }));`;

      const saved = yield* save(cloud, source, () => Effect.succeed(null));
      if (!saved.ok) return expect.unreachable();
      const started = yield* runNow(cloud, saved.automation.id, failIfResolved);
      yield* cloud.settle;

      const run = yield* cloud.inUser(
        userId,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(started.id)),
      );
      expect([run.run.status, run.run.error]).toEqual([
        "failed",
        expect.stringContaining("Choose a model or set a default"),
      ]);
    }),
  );

  it.effect("resolves an implicit model from the current context when the step runs", () =>
    Effect.gen(function* () {
      const cloud = yield* setup();
      const source = `export const meta = { name: "Default added later" } as const;
export default workflow(async (w) => await w.agent("Echo", { prompt: "hello" }));`;

      const saved = yield* save(cloud, source, () => Effect.succeed(null));
      if (!saved.ok) return expect.unreachable();
      const rpc = yield* settingsClient(cloud);
      yield* rpc[WS_METHODS.serverUpdateSettings]({
        patch: { defaultModelSelection: scriptedModelSelection },
      });

      const started = yield* runNow(cloud, saved.automation.id, failIfResolved);
      yield* cloud.settle;
      const run = yield* cloud.inUser(
        userId,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(started.id)),
      );
      expect(run.run).toMatchObject({ status: "succeeded", error: null });
      const step = run.steps.find((candidate) => candidate.verb === "agent");
      const threadId = step?.threadId;
      expect(threadId).toBeTruthy();
      if (threadId === undefined || threadId === null) return;
      const shell = yield* cloud.inUser(
        userId,
        AutomationThreads.use((threads) => threads.getThreadShell(threadId)),
      );

      expect(run.run.status).toBe("succeeded");
      expect(shell?.modelSelection).toEqual(scriptedModelSelection);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the model defaults captured by the first save when editing", () =>
    Effect.gen(function* () {
      const cloud = yield* setup();
      const source = `export const meta = { name: "Keep my model" } as const;
export default workflow(async (w) => await w.agent("Echo", { prompt: "hello" }));`;
      const savedModel: ModelSelection = {
        ...scriptedModelSelection,
        options: [{ id: "test-setting", value: "saved" }],
      };
      const currentModel: ModelSelection = {
        ...scriptedModelSelection,
        options: [{ id: "test-setting", value: "current" }],
      };
      let resolverCalls = 0;
      const saved = yield* save(cloud, source, () => {
        resolverCalls += 1;
        return Effect.succeed(savedModel);
      });
      if (!saved.ok) return expect.unreachable();

      const edited = yield* save(cloud, source, () => {
        resolverCalls += 1;
        return Effect.succeed(currentModel);
      });
      if (!edited.ok) return expect.unreachable();

      const started = yield* runNow(cloud, saved.automation.id, failIfResolved);
      yield* cloud.settle;
      const run = yield* cloud.inUser(
        userId,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(started.id)),
      );
      const step = run.steps.find((candidate) => candidate.verb === "agent");
      const threadId = step?.threadId;
      expect(threadId).toBeTruthy();
      if (threadId === undefined || threadId === null) return;
      const shell = yield* cloud.inUser(
        userId,
        AutomationThreads.use((threads) => threads.getThreadShell(threadId)),
      );

      expect(resolverCalls).toBe(1);
      expect(shell?.modelSelection).toEqual(savedModel);
    }),
  );
});
