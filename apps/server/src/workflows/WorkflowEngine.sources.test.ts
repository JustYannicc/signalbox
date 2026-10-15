// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import { expect, it } from "@effect/vitest";
import type { AutomationNotice } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import {
  DEFAULTS,
  fakeHttp,
  fakeThreads,
  fakeTools,
  jsonResponse,
  PROJECT,
  saveOk,
  withEngine,
  withRestartableEngine,
} from "./WorkflowEngine.testkit.ts";

/** A fake Executor whose list operation answers with `runs`, or fails while `failing` counts down. */
function fakeSource() {
  const state = {
    runs: [{ id: 1, status: "completed", updated_at: "1" }] as Array<Record<string, unknown>>,
    calls: 0,
    failing: 0,
    failStatus: 429,
  };
  const http = fakeHttp({
    "https://executor.example/api/executions": () =>
      Effect.sync(() => {
        state.calls += 1;
        if (state.failing > 0) {
          state.failing -= 1;
          return jsonResponse({ text: "Slow down" }, { status: state.failStatus });
        }
        return jsonResponse({
          status: "completed",
          structured: {
            status: "completed",
            result: {
              ok: true,
              value: { total_count: state.runs.length, workflow_runs: structuredClone(state.runs) },
            },
          },
        });
      }),
  });
  const environment = {
    ...NodeProcess.env,
    SIGNALBOX_EXECUTOR_URL: "https://executor.example",
    SIGNALBOX_EXECUTOR_API_KEY: "server-secret",
  };
  return { state, http, environment };
}

const WATCH = `{ operation: "github.actions.listWorkflowRunsForRepo", args: { owner: "o", repo: "r" }, key: "id", every: { minutes: 1 } }`;

const source = (name: string, on: string, extra = "") =>
  `export const meta = { name: "${name}", triggers: [{ on: "${on}", watch: ${WATCH.replace(/ }$/, `${extra} }`)} }] } as const;
export default workflow(async (w, input: any) => input.key);`;

/** One check of every due source, and everything it starts. */
const check = (engine: WorkflowEngine["Service"], after: Duration.Input = "1 minute") =>
  Effect.gen(function* () {
    yield* TestClock.adjust(after);
    yield* engine.tick;
    yield* engine.drain;
  });

it.effect(
  "a new item starts the automation once: not for the first read, and not again after a restart",
  () => {
    const fake = fakeSource();
    return withRestartableEngine({ http: fake.http, environment: fake.environment }, (start) =>
      Effect.gen(function* () {
        const first = yield* start;
        const automation = yield* saveOk(source("New runs", "source.item.added")).pipe(
          Effect.provideService(WorkflowEngine, first.engine),
        );
        yield* check(first.engine, "0 millis");
        expect(fake.state.calls).toBe(1);
        expect((yield* first.engine.get(automation.id)).runs).toEqual([]);

        fake.state.runs.unshift({ id: 2, status: "queued", updated_at: "2" });
        yield* check(first.engine);
        const runs = (yield* first.engine.get(automation.id)).runs;
        expect(runs).toHaveLength(1);
        expect((yield* first.engine.getRun(runs[0]!.id)).output).toBe("2");
        expect((yield* first.engine.get(automation.id)).watching).toMatchObject([
          { operation: "github.actions.listWorkflowRunsForRepo", status: "watching" },
        ]);
        yield* first.stop;

        // The restarted server picks up from the stored read: run 2 isn't new to it.
        const second = yield* start;
        yield* check(second.engine);
        expect((yield* second.engine.get(automation.id)).runs).toHaveLength(1);
        fake.state.runs.unshift({ id: 3, status: "queued", updated_at: "3" });
        // Nothing changed at the last read, so it's read a little less often.
        yield* check(second.engine, "90 seconds");
        const after = (yield* second.engine.get(automation.id)).runs;
        expect(after).toHaveLength(2);
        expect((yield* second.engine.getRun(after[0]!.id)).output).toBe("3");
      }),
    );
  },
);

it.effect("two automations and an agent's wait on the same source share one read", () => {
  const fake = fakeSource();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { http: fake.http, environment: fake.environment },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const one = yield* saveOk(source("One", "source.item.added"));
      const two = yield* saveOk(source("Two", "source.item.*", `, fields: ["status"]`));
      const wait = yield* engine.startWait(
        {
          threadId: "thread-agent",
          until: "a new workflow run",
          watch: {
            operation: "github.actions.listWorkflowRunsForRepo",
            args: { repo: "r", owner: "o" },
            key: "id",
          },
          on: "source.item.added",
        },
        { builtInDefaults: DEFAULTS },
      );
      yield* engine.drain;
      yield* check(engine, "0 millis");
      expect(fake.state.calls).toBe(1);

      fake.state.runs.unshift({ id: 2, status: "queued", updated_at: "2" });
      yield* check(engine);
      expect(fake.state.calls).toBe(2);
      expect((yield* engine.get(one.id)).runs).toHaveLength(1);
      expect((yield* engine.get(two.id)).runs).toHaveLength(1);
      expect((yield* engine.getRun(wait.waitId)).run.status).toBe("succeeded");
      expect(tools.calls).toMatchObject([
        {
          tool: "t3_thread_send",
          args: {
            threadId: "thread-agent",
            message: expect.stringContaining("You were waiting for a new workflow run."),
          },
        },
      ]);
    }),
  );
});

it.effect(
  "an agent waiting on a source with a condition wakes only when the judge says it holds",
  () => {
    const fake = fakeSource();
    const threads = fakeThreads();
    const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
    return withEngine(
      { http: fake.http, environment: fake.environment, threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        yield* engine.startWait(
          {
            threadId: "thread-agent",
            until: "the build to fail",
            on: "source.item.changed",
            watch: {
              operation: "github.actions.listWorkflowRunsForRepo",
              args: { owner: "o", repo: "r" },
              key: "id",
              every: { minutes: 1 },
            },
            condition: "its status is failure",
          },
          { builtInDefaults: DEFAULTS },
        );
        yield* engine.drain;
        yield* check(engine, "0 millis");

        fake.state.runs[0] = { id: 1, status: "in_progress", updated_at: "2" };
        yield* check(engine);
        expect(threads.launches).toHaveLength(1);
        threads.state.replies["thread-1"] = "no";
        threads.state.finished = true;
        yield* threads.runEnded("thread-1");
        yield* engine.drain;
        expect(tools.calls).toEqual([]);

        fake.state.runs[0] = { id: 1, status: "failure", updated_at: "3" };
        threads.state.replies["thread-2"] = "yes";
        yield* check(engine);
        expect(threads.launches).toHaveLength(2);
        yield* threads.runEnded("thread-2");
        yield* engine.drain;
        expect(tools.calls).toMatchObject([
          {
            tool: "t3_thread_send",
            args: { message: expect.stringContaining('"status":"failure"') },
          },
        ]);
      }),
    );
  },
);

it.effect("source.item.changed counts only the watch's fields, and carries the item before", () => {
  const fake = fakeSource();
  return withEngine(
    { http: fake.http, environment: fake.environment },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const changed = yield* saveOk(
        `export const meta = { name: "Status", triggers: [{ on: "source.item.changed", watch: ${WATCH.replace(/ }$/, `, fields: ["status"] }`)} }] } as const;
export default workflow(async (w, input: any) => ({ was: input.before.status, now: input.item.status, changed: input.changed }));`,
      );
      yield* check(engine, "0 millis");
      fake.state.runs[0] = { id: 1, status: "completed", updated_at: "9" };
      yield* check(engine);
      expect((yield* engine.get(changed.id)).runs).toEqual([]);

      fake.state.runs[0] = { id: 1, status: "failure", updated_at: "10" };
      yield* check(engine);
      const runs = (yield* engine.get(changed.id)).runs;
      expect(runs).toHaveLength(1);
      expect((yield* engine.getRun(runs[0]!.id)).output).toEqual({
        was: "completed",
        now: "failure",
        changed: ["status", "updated_at"],
      });
    }),
  );
});

it.effect(
  "failed reads back off and recover; too many in a row pause the source and tell the owner once",
  () => {
    const fake = fakeSource();
    return withEngine(
      { http: fake.http, environment: fake.environment },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const notices = yield* engine.subscribeNotices;
        const heard = yield* notices.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
        const automation = yield* saveOk(source("New runs", "source.item.added"));
        yield* check(engine, "0 millis");

        // A 429 waits twice the interval before trying again, then the next read goes through.
        fake.state.failing = 1;
        yield* check(engine);
        expect(fake.state.calls).toBe(2);
        expect((yield* engine.get(automation.id)).watching).toMatchObject([
          { status: "failing", error: expect.stringContaining("429") },
        ]);
        fake.state.runs.unshift({ id: 2, status: "queued", updated_at: "2" });
        yield* check(engine);
        expect(fake.state.calls).toBe(2);
        yield* check(engine);
        expect(fake.state.calls).toBe(3);
        expect((yield* engine.get(automation.id)).runs).toHaveLength(1);
        expect((yield* engine.get(automation.id)).watching).toMatchObject([{ status: "watching" }]);

        // Five failures in a row pause it, with one notice.
        fake.state.failing = 100;
        fake.state.failStatus = 503;
        for (let index = 0; index < 5; index++) yield* check(engine, "1 hour");
        expect(fake.state.calls).toBe(8);
        const [notice] = yield* Fiber.join(heard);
        expect(notice).toMatchObject({
          kind: "failed",
          automationId: automation.id,
          body: expect.stringContaining("github.actions.listWorkflowRunsForRepo"),
        } satisfies Partial<AutomationNotice>);
        yield* check(engine, "1 hour");
        expect(fake.state.calls).toBe(8);
        expect((yield* engine.get(automation.id)).watching).toMatchObject([{ status: "paused" }]);

        // Saving it again is someone new watching: it reads again.
        fake.state.failing = 0;
        yield* engine.save({
          automationId: automation.id,
          source: source("New runs", "source.item.added", `, fields: ["status"]`),
          projectId: PROJECT,
          defaults: DEFAULTS,
        });
        yield* check(engine, "0 millis");
        expect(fake.state.calls).toBe(9);
        expect((yield* engine.get(automation.id)).watching).toMatchObject([{ status: "watching" }]);
      }).pipe(Effect.scoped),
    );
  },
);

it.effect(
  "a source that stops reading wakes the agent waiting on it, and never reaches other triggers",
  () => {
    const fake = fakeSource();
    const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
    return withEngine(
      { http: fake.http, environment: fake.environment },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const everything = yield* saveOk(
          `export const meta = { name: "Everything", triggers: [{ on: "*" }] } as const;
export default workflow(async (w, input: any) => input.event);`,
        );
        const wait = yield* engine.startWait(
          {
            threadId: "thread-agent",
            until: "a new run",
            watch: {
              operation: "github.actions.listWorkflowRunsForRepo",
              args: { owner: "o", repo: "r" },
              key: "id",
              every: { minutes: 1 },
            },
          },
          { builtInDefaults: DEFAULTS },
        );
        yield* engine.drain;
        yield* check(engine, "0 millis");
        fake.state.runs.unshift({ id: 2, status: "queued", updated_at: "2" });
        fake.state.failing = 100;
        for (let index = 0; index < 5; index++) yield* check(engine, "1 hour");
        expect((yield* engine.getRun(wait.waitId)).run.status).toBe("succeeded");
        expect(tools.calls).toMatchObject([
          {
            tool: "t3_thread_send",
            args: { message: expect.stringContaining("I stopped waiting: Couldn't read") },
          },
        ]);
        const seen = yield* Effect.forEach((yield* engine.get(everything.id)).runs, (run) =>
          engine.getRun(run.id).pipe(Effect.map((detail) => detail.output)),
        );
        expect(seen.filter((event) => String(event).startsWith("source."))).toEqual([]);
      }),
    );
  },
);

it.effect("a watch has to name an operation and go with source events", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const save = (triggers: string) =>
        engine.save({
          source: `export const meta = { name: "Bad", triggers: ${triggers} } as const;
export default workflow(async (w) => null);`,
          projectId: PROJECT,
          defaults: DEFAULTS,
        });
      const firstMessage = (result: {
        ok: boolean;
        diagnostics?: ReadonlyArray<{ message: string }>;
      }) => (result.ok ? "" : (result.diagnostics?.[0]?.message ?? ""));
      expect(
        firstMessage(
          yield* save(`[{ on: "turn.finished", watch: { operation: "a.b", key: "id" } }]`),
        ),
      ).toContain("`watch` goes with source.item.* events");
      expect(
        firstMessage(
          yield* save(`[{ on: "source.item.added", watch: { operation: "nodots", key: "id" } }]`),
        ),
      ).toContain("isn't an operation name");
      expect(
        firstMessage(
          yield* save(
            `[{ on: "source.item.added", watch: { operation: "a.b", key: "id", every: { seconds: 5 } } }]`,
          ),
        ),
      ).toContain("at most once a minute");
      expect(firstMessage(yield* save(`[{ on: "source.item.added" }]`))).toContain(
        "need a `watch`",
      );
    }),
  ),
);

const RUNS_WATCH = {
  operation: "github.actions.listWorkflowRunsForRepo",
  args: { owner: "o", repo: "r" },
  key: "id",
} as const;

it.effect("a failing source keeps its backoff when someone who wants it faster joins", () => {
  const fake = fakeSource();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { http: fake.http, environment: fake.environment },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      yield* saveOk(
        `export const meta = { name: "Hourly", triggers: [{ on: "source.item.added", watch: { operation: "github.actions.listWorkflowRunsForRepo", args: { owner: "o", repo: "r" }, key: "id", every: { hours: 1 } } }] } as const;
export default workflow(async (w, input: any) => input.key);`,
      );
      yield* check(engine, "0 millis");
      fake.state.failing = 100;
      yield* check(engine, "1 hour");
      expect(fake.state.calls).toBe(2);

      // An agent waiting every 5 minutes joins while the source backs off for an hour.
      yield* engine.startWait(
        { threadId: "thread-agent", until: "a new run", watch: RUNS_WATCH },
        { builtInDefaults: DEFAULTS },
      );
      yield* engine.drain;
      for (let index = 0; index < 10; index++) yield* check(engine, "5 minutes");
      expect(fake.state.calls).toBe(2);
      yield* check(engine, "15 minutes");
      expect(fake.state.calls).toBe(3);
    }),
  );
});

it.effect("someone who starts watching later never hears about changes from before", () => {
  const fake = fakeSource();
  return withEngine(
    { http: fake.http, environment: fake.environment },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const first = yield* saveOk(source("First", "source.item.added"));
      yield* check(engine, "0 millis");
      yield* engine.setEnabled(first.id, false);

      // Run 2 shows up while nobody watches; the stored read still says only run 1.
      fake.state.runs.unshift({ id: 2, status: "queued", updated_at: "2" });
      yield* TestClock.adjust("10 minutes");
      const later = yield* saveOk(source("Later", "source.item.added"));
      yield* check(engine, "0 millis");
      expect((yield* engine.get(later.id)).runs).toEqual([]);

      fake.state.runs.unshift({ id: 3, status: "queued", updated_at: "3" });
      yield* check(engine);
      const runs = (yield* engine.get(later.id)).runs;
      expect(runs).toHaveLength(1);
      expect((yield* engine.getRun(runs[0]!.id)).output).toBe("3");
    }),
  );
});

it.effect("a source paused after failing stays paused across a restart", () => {
  const fake = fakeSource();
  return withRestartableEngine({ http: fake.http, environment: fake.environment }, (start) =>
    Effect.gen(function* () {
      const first = yield* start;
      const automation = yield* saveOk(source("New runs", "source.item.added")).pipe(
        Effect.provideService(WorkflowEngine, first.engine),
      );
      yield* check(first.engine, "0 millis");
      fake.state.failing = 100;
      for (let index = 0; index < 5; index++) yield* check(first.engine, "1 hour");
      expect(fake.state.calls).toBe(6);
      yield* first.stop;

      const second = yield* start;
      for (let index = 0; index < 3; index++) yield* check(second.engine, "1 hour");
      expect(fake.state.calls).toBe(6);
      expect((yield* second.engine.get(automation.id)).watching).toMatchObject([
        { status: "paused" },
      ]);
    }),
  );
});

it.effect("a list too long to watch fails with how to narrow it", () => {
  const fake = fakeSource();
  fake.state.runs = Array.from({ length: 1001 }, (_, index) => ({ id: index, status: "done" }));
  return withEngine(
    { http: fake.http, environment: fake.environment },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(source("Big", "source.item.added"));
      yield* check(engine, "0 millis");
      expect((yield* engine.get(automation.id)).watching).toMatchObject([
        { status: "failing", error: expect.stringContaining("narrow it with args") },
      ]);
    }),
  );
});
