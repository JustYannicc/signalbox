import {
  ProviderInstanceId,
  ThreadId,
  type AutomationDefaults,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  AutomationThreads,
  type AutomationThreadLaunch,
  type AutomationThreadsShape,
} from "./host.ts";
import { agentResult, launchAgent } from "./steps.ts";
import type { StepRow } from "./WorkflowStore.ts";

const threadId = "thread-sync";
const run = { id: "run-1", status: "completed" };

/** A thread as the cloud keeps it: pull requests only in `pullRequests`, no legacy fields. */
const threads = (pullRequests: ReadonlyArray<unknown>) =>
  ({
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        deletedAt: null,
        branch: "signalbox/0000sync",
        worktreePath: "/drives/d/threads/thread-sync",
        pullRequests,
      } as never),
    getThreadRecords: () => Effect.succeed({ runs: [run], messages: [], turnItems: [] } as never),
  }) as unknown as AutomationThreadsShape;

const link = (number: number, linkedAt: string) => ({
  host: "github.com",
  repository: "justyannicc/signalbox",
  number,
  url: `https://github.com/JustYannicc/signalbox/pull/${number}`,
  source: "agent",
  linkedAt,
  snapshot: null,
  stack: null,
});

describe("an agent step's result", () => {
  it.effect("names the pull request the agent opened, kept as a thread link (#5)", () =>
    Effect.gen(function* () {
      const result = yield* agentResult(threadId, run.id).pipe(
        Effect.provideService(AutomationThreads, threads([link(729, "2026-10-16T20:27:00Z")])),
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          branch: "signalbox/0000sync",
          pullRequest: { number: 729, url: "https://github.com/JustYannicc/signalbox/pull/729" },
        },
      });
    }),
  );

  it.effect("has no pull request when the thread links none", () =>
    Effect.gen(function* () {
      const result = yield* agentResult(threadId, run.id).pipe(
        Effect.provideService(AutomationThreads, threads([])),
      );
      expect(result).toMatchObject({ ok: true, value: { pullRequest: null } });
    }),
  );
});

const noModelDefaults: AutomationDefaults = {
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
};
const agentStep = {
  run_id: "run-model-default",
  step_key: "s1",
  label: "Echo",
  attempt: 1,
} as unknown as StepRow;

describe("agent step model selection", () => {
  it.effect("uses a provider and model named by the step without saved defaults", () =>
    Effect.gen(function* () {
      let launched: AutomationThreadLaunch | undefined;
      const threads = {
        launch: (input: AutomationThreadLaunch) => {
          launched = input;
          return Effect.succeed({ threadId: ThreadId.make("thread-explicit-model") });
        },
      } as unknown as AutomationThreadsShape;

      yield* launchAgent({
        step: agentStep,
        options: { prompt: "hello", provider: "scripted", model: "scripted-echo" },
        projectId: "project-1",
        defaults: noModelDefaults,
        timeoutMs: null,
      }).pipe(Effect.provideService(AutomationThreads, threads));

      expect(launched?.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make("scripted"),
        model: "scripted-echo",
      } satisfies ModelSelection);
    }),
  );

  it.effect("leaves an implicit model to the host when no default was saved", () =>
    Effect.gen(function* () {
      let launched: AutomationThreadLaunch | undefined;
      const threads = {
        launch: (input: AutomationThreadLaunch) => {
          launched = input;
          return Effect.succeed({ threadId: ThreadId.make("thread-host-default") });
        },
      } as unknown as AutomationThreadsShape;

      const result = yield* launchAgent({
        step: agentStep,
        options: { prompt: "hello" },
        projectId: "project-1",
        defaults: noModelDefaults,
        timeoutMs: null,
      }).pipe(Effect.provideService(AutomationThreads, threads));

      expect(result).toMatchObject({ type: "waiting", threadId: "thread-host-default" });
      expect(launched).not.toHaveProperty("modelSelection");
    }),
  );

  it.effect("continues an existing thread without a saved default", () =>
    Effect.gen(function* () {
      let sent: ModelSelection | undefined;
      const threadId = ThreadId.make("thread-existing-model");
      const threads = {
        getThreadShell: () =>
          Effect.succeed({ id: threadId, deletedAt: null, projectId: "project-1" } as never),
        send: (input: { readonly modelSelection?: ModelSelection }) => {
          sent = input.modelSelection;
          return Effect.succeed({ run: { id: "run-continued" } as never });
        },
      } as unknown as AutomationThreadsShape;

      const result = yield* launchAgent({
        step: agentStep,
        options: { prompt: "continue", thread: threadId },
        projectId: "project-1",
        defaults: noModelDefaults,
        timeoutMs: null,
      }).pipe(Effect.provideService(AutomationThreads, threads));

      expect(result).toMatchObject({ type: "waiting", threadId });
      expect(sent).toBeUndefined();
    }),
  );
});
