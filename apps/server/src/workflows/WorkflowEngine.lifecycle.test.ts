// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";
import {
  DEFAULTS,
  fakeHttp,
  fakeThreads,
  jsonResponse,
  saveOk,
  withEngine,
  acceptedRun,
  webhookRequest,
} from "./WorkflowEngine.testkit.ts";

/** An HTTP route that never answers, and says when it was called and when it was abandoned. */
const hangingRoute = Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const abandoned = yield* Deferred.make<void>();
  const route = () =>
    Deferred.succeed(arrived, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(abandoned, undefined)),
    );
  return { arrived, abandoned, route };
});

it.effect("cancel stops the run's agents, requests and the runs it started", () => {
  const threads = fakeThreads();
  return Effect.gen(function* () {
    const hanging = yield* hangingRoute;
    const http = fakeHttp({ "https://slow.example/": hanging.route });
    yield* withEngine(
      { threads, http },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* saveOk(`export const meta = { name: "Child" } as const;
export default workflow(async (w) => { await w.ask("Wait", {}); });`);
        const parent = yield* saveOk(`export const meta = { name: "Parent" } as const;
export default workflow(async (w) => {
  await w.start("Kick off", "Child", {});
  await w.agent("Work", { prompt: "go" });
});`);
        const run = yield* engine.startRun({ automationId: parent.id, trigger: "manual" });
        yield* engine.drain;
        const child = (yield* engine.list()).find((automation) => automation.name === "Child")!;
        expect(child.lastRun?.status).toBe("running");

        yield* engine.cancelRun(run.id);
        yield* engine.drain;
        const detail = yield* engine.getRun(run.id);
        expect(detail.run.status).toBe("cancelled");
        expect(detail.steps.at(-1)).toMatchObject({
          label: "Work",
          status: "failed",
          error: "The run was cancelled.",
        });
        expect(threads.interrupts).toEqual([
          { threadId: "thread-1", commandId: `automation:${run.id}:s2:stop` },
        ]);
        const childRun = (yield* engine.get(child.id)).runs[0]!;
        expect(childRun.status).toBe("cancelled");
        // Cancel only interrupts threads once, however often it's asked.
        yield* engine.cancelRun(run.id);
        expect(threads.interrupts).toHaveLength(1);

        const slow = yield* saveOk(`export const meta = { name: "Slow" } as const;
export default workflow(async (w) => { await w.http("Fetch", "https://slow.example/"); });`);
        const slowRun = yield* engine.startRun({ automationId: slow.id, trigger: "manual" });
        yield* Deferred.await(hanging.arrived);
        yield* engine.cancelRun(slowRun.id);
        // Drain only returns because the request's fiber was interrupted.
        yield* engine.drain;
        yield* Deferred.await(hanging.abandoned);
        expect((yield* engine.getRun(slowRun.id)).steps[0]).toMatchObject({ status: "failed" });
      }),
    );
  });
});

it.effect("delete stops running runs and removes everything the automation stored", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const automation = yield* saveOk(
        `export const meta = { name: "Installs" } as const;
function hello(): string { return "hi"; }
export default workflow(async (w) => {
  await w.run("Say hi", hello);
  await w.agent("Work", { prompt: "go" });
});`,
        { defaults: { ...DEFAULTS, runtimeMode: "full-access" } },
      );
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      const directory = path.join(config.stateDir, "automations", automation.id);
      expect(yield* fs.exists(directory)).toBe(true);

      yield* engine.remove(automation.id);
      expect(threads.interrupts.map((interrupt) => interrupt.threadId)).toEqual(["thread-1"]);
      expect(yield* engine.list()).toEqual([]);
      expect((yield* engine.getRun(run.id).pipe(Effect.flip)).message).toContain("doesn't exist");
      expect(yield* fs.exists(directory)).toBe(false);
    }),
  );
});

it.effect("http steps time out, and refuse bodies over 5 MB", () =>
  Effect.gen(function* () {
    const hanging = yield* hangingRoute;
    const http = fakeHttp({
      "https://slow.example/": hanging.route,
      "https://huge.example/": () => Effect.succeed(new Response("x".repeat(5 * 1024 * 1024 + 1))),
      "https://declared.example/": () =>
        Effect.succeed(new Response("small", { headers: { "content-length": "999999999" } })),
    });
    yield* withEngine(
      { http },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const run = (url: string, options = "") =>
          Effect.gen(function* () {
            const automation = yield* saveOk(`export const meta = { name: "Fetch ${url}" } as const;
export default workflow(async (w) => { await w.http("Fetch", { url: "${url}"${options} }); });`);
            return yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
          });

        const slow = yield* run(
          "https://slow.example/",
          ", timeout: { seconds: 5 }, retry: { attempts: 1 }",
        );
        yield* Deferred.await(hanging.arrived);
        yield* TestClock.adjust("5 seconds");
        yield* engine.drain;
        expect((yield* engine.getRun(slow.id)).steps[0]?.error).toBe(
          "https://slow.example/ didn't answer within 5 seconds.",
        );

        for (const url of ["https://huge.example/", "https://declared.example/"]) {
          const big = yield* run(url);
          yield* engine.drain;
          expect((yield* engine.getRun(big.id)).steps[0]).toMatchObject({
            status: "failed",
            error: `The response from ${url} is over 5 MB.`,
          });
        }
      }),
    );
  }),
);

it.effect("agent steps, unanswered asks and whole runs time out", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const start = (source: string) =>
        saveOk(source).pipe(
          Effect.flatMap((automation) =>
            engine.startRun({ automationId: automation.id, trigger: "manual" }),
          ),
        );
      const agent = yield* start(`export const meta = { name: "Agent" } as const;
export default workflow(async (w) => { await w.agent("Work", { prompt: "go", timeout: { minutes: 30 } }); });`);
      const ask = yield* start(`export const meta = { name: "Ask" } as const;
export default workflow(async (w) => {
  return await w.ask("Ship?", { options: ["ship", "hold"], timeout: { days: 3 }, onTimeout: "hold" });
});`);
      const slow =
        yield* start(`export const meta = { name: "Slowpoke", timeout: { hours: 1 } } as const;
export default workflow(async (w) => { await w.ask("Wait", {}); });`);
      yield* engine.drain;

      yield* TestClock.adjust("30 minutes");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(agent.id)).toMatchObject({
        run: { status: "failed", error: "The agent didn't finish within 30 minutes." },
      });
      expect(threads.interrupts).toEqual([
        { threadId: "thread-1", commandId: `automation:${agent.id}:s1:timeout:1` },
      ]);

      yield* TestClock.adjust("30 minutes");
      yield* engine.tick;
      yield* engine.drain;
      const timedOut = yield* engine.getRun(slow.id);
      expect(timedOut.run).toMatchObject({
        status: "failed",
        error: "The run didn't finish within its 1 hour timeout.",
      });
      expect(timedOut.steps[0]).toMatchObject({ status: "failed" });
      expect((yield* engine.getRun(ask.id)).run.status).toBe("running");

      yield* TestClock.adjust("3 days");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(ask.id)).toMatchObject({
        run: { status: "succeeded" },
        output: "hold",
      });
    }),
  );
});

it.effect("retries 5xx answers with backoff and Retry-After, journaling each attempt", () => {
  let calls = 0;
  const http = fakeHttp({
    "https://flaky.example/": () =>
      Effect.sync(() =>
        ++calls === 1
          ? jsonResponse({ busy: true }, { status: 503, headers: { "retry-after": "7" } })
          : jsonResponse({ items: 5 }),
      ),
  });
  return withEngine(
    { http },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Flaky" } as const;
export default workflow(async (w) => (await w.http("Fetch", "https://flaky.example/")).body);`);
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).steps[0]).toMatchObject({
        status: "waiting",
        attempt: 2,
        error: "https://flaky.example/ answered 503.",
      });

      // Backoff is 5 seconds, but the server asked for 7.
      yield* TestClock.adjust("6 seconds");
      yield* engine.tick;
      yield* engine.drain;
      expect(calls).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* engine.tick;
      yield* engine.drain;
      const detail = yield* engine.getRun(run.id);
      expect(detail).toMatchObject({ run: { status: "succeeded" }, output: { items: 5 } });
      expect(detail.steps[0]).toMatchObject({ attempt: 2, error: null });
      const keys = http.sent.map((request) => request.headers["idempotency-key"]);
      expect(keys).toEqual([`${run.id}/s1`, `${run.id}/s1`]);
    }),
  );
});

it.effect("asks the model again when its answer can't be read", () => {
  const threads = fakeThreads();
  threads.state.finished = true;
  threads.state.replies["thread-1"] = "Hard to say.";
  threads.state.reply = "bug";
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Judge" } as const;
export default workflow(async (w) => await w.judge("Kind?", { input: "x", outcomes: ["bug", "noise"] }));`);
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      yield* threads.runEnded("thread-1");
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).steps[0]).toMatchObject({
        status: "waiting",
        attempt: 2,
      });
      yield* TestClock.adjust("5 seconds");
      yield* engine.tick;
      yield* engine.drain;
      expect(threads.launches[1]?.commandId).toBe(`automation:${run.id}:s1:attempt-2`);
      yield* threads.runEnded("thread-2");
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: "bug",
      });
    }),
  );
});

it.effect("retries a replay that failed outside the code instead of failing the run", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const automation = yield* saveOk(`export const meta = { name: "Steady" } as const;
export default workflow(async (w) => { await w.notify("Hi", "there"); return 1; });`);
      yield* sql.unsafe("ALTER TABLE signalbox_automation_steps RENAME TO steps_away");
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(run.id).pipe(Effect.flip)).message).toContain("storage");
      yield* sql.unsafe("ALTER TABLE steps_away RENAME TO signalbox_automation_steps");
      expect((yield* engine.getRun(run.id)).run.status).toBe("running");

      yield* TestClock.adjust("1 second");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: 1,
      });
    }),
  ),
);

it.effect("tells the owner when a run fails, louder when nobody started it by hand", () =>
  withEngine(
    {},
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const automation =
          yield* saveOk(`export const meta = { name: "Breaks", triggers: [{ webhook: true }] } as const;
export default workflow(async (w, input: { fail?: boolean }) => {
  if (input?.fail) throw new Error("Linear is down.");
  await w.notify("Fine", "fine", { importance: "low" });
});`);
        const notices = yield* engine.subscribeNotices;
        const collected = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(notices, (notice) => notice.kind === "failed"),
            2,
          ),
        ).pipe(Effect.forkScoped);
        yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
        const manual = yield* engine.startRun({
          automationId: automation.id,
          input: { fail: true },
          trigger: "manual",
        });
        yield* engine.drain;
        const hooked = yield* acceptedRun(
          yield* engine.receiveWebhook(webhookRequest(automation, { body: '{"fail":true}' })),
        );
        yield* engine.drain;
        const seen = yield* Fiber.join(collected);
        expect(
          seen.map(({ id, kind, body, importance }) => ({ id, kind, body, importance })),
        ).toEqual([
          {
            id: `${manual.id}/failed`,
            kind: "failed",
            body: "Linear is down.",
            importance: "normal",
          },
          {
            id: `${hooked.runId}/failed`,
            kind: "failed",
            body: "Linear is down.",
            importance: "high",
          },
        ]);
      }),
    ),
  ),
);

it.effect("keeps the latest replay's console lines on the run", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Chatty" } as const;
export default workflow(async (w) => {
  console.log("found", 3);
  console.warn({ a: 1 });
  await w.notify("Hi", "there");
  console.error("done");
});`);
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      const { logs } = yield* engine.getRun(run.id);
      expect(logs.map(({ level, message }) => ({ level, message }))).toEqual([
        { level: "log", message: "found 3" },
        { level: "warn", message: '{"a":1}' },
        { level: "error", message: "done" },
      ]);
      expect(logs[0]?.at).toBe(run.startedAt);
    }),
  ),
);

it.effect(
  "one broken step doesn't hold up the tick, and a deleted agent thread fails its step",
  () => {
    const threads = fakeThreads();
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const agent = yield* saveOk(`export const meta = { name: "Agent" } as const;
export default workflow(async (w) => { await w.agent("Work", { prompt: "go" }); });`);
        const sleeper = yield* saveOk(`export const meta = { name: "Sleeper" } as const;
export default workflow(async (w) => { await w.sleep("Nap", { minutes: 1 }); return "rested"; });`);
        const agentRun = yield* engine.startRun({ automationId: agent.id, trigger: "manual" });
        const sleeperRun = yield* engine.startRun({ automationId: sleeper.id, trigger: "manual" });
        yield* engine.drain;

        threads.state.broken = true;
        yield* TestClock.adjust("1 minute");
        yield* engine.tick;
        yield* engine.drain;
        expect((yield* engine.getRun(sleeperRun.id)).run.status).toBe("succeeded");
        expect((yield* engine.getRun(agentRun.id)).run.status).toBe("running");

        // No event says a deleted thread ended; the periodic sweep finds it.
        threads.state.broken = false;
        threads.state.deleted.add("thread-1");
        yield* TestClock.adjust("1 minute");
        yield* engine.tick;
        yield* engine.drain;
        expect(yield* engine.getRun(agentRun.id)).toMatchObject({
          run: { status: "failed", error: "The agent's thread was deleted." },
        });
      }),
    );
  },
);

it.effect("w.run sees a minimal environment, and old installs are pruned", () =>
  Effect.gen(function* () {
    NodeProcess.env.SIGNALBOX_AUTOMATION_TEST_SECRET = "leaked";
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        delete NodeProcess.env.SIGNALBOX_AUTOMATION_TEST_SECRET;
      }),
    );
    yield* withEngine(
      {},
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const automation = yield* saveOk(
          `export const meta = { name: "Env" } as const;
function readEnv(): { secret: string | null; path: boolean } {
  return { secret: process.env.SIGNALBOX_AUTOMATION_TEST_SECRET ?? null, path: Boolean(process.env.PATH) };
}
export default workflow(async (w) => await w.run("Read env", readEnv));`,
          { defaults: { ...DEFAULTS, runtimeMode: "full-access" } },
        );
        const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
        yield* engine.drain;
        expect(yield* engine.getRun(run.id)).toMatchObject({
          run: { status: "succeeded" },
          output: { secret: null, path: true },
        });

        const directory = path.join(config.stateDir, "automations", automation.id);
        yield* fs.makeDirectory(path.join(directory, "v7"), { recursive: true });
        // Cleanup runs at most hourly; the first tick ran when the engine started.
        yield* TestClock.adjust("1 hour");
        yield* engine.tick;
        expect((yield* fs.readDirectory(directory)).toSorted()).toEqual(["v1"]);
      }),
    );
  }).pipe(Effect.scoped),
);

it.effect("prunes finished runs older than 30 days but keeps each automation's latest 50", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const automation = yield* saveOk(`export const meta = { name: "Often" } as const;
export default workflow(async (w) => { await w.notify("Hi", "x", { importance: "low" }); });`);
      for (let index = 0; index < 53; index++) {
        yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      }
      yield* engine.drain;
      const count = sql<{ runs: number; steps: number }>`
        SELECT
          (SELECT COUNT(*) FROM signalbox_automation_runs) AS runs,
          (SELECT COUNT(*) FROM signalbox_automation_steps) AS steps
      `;
      yield* engine.tick;
      expect((yield* count)[0]).toEqual({ runs: 53, steps: 53 });
      yield* TestClock.adjust("31 days");
      yield* engine.tick;
      expect((yield* count)[0]).toEqual({ runs: 50, steps: 50 });
    }),
  ),
);

it.effect("explains failures, and writes one wide event per run to the automation log", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const automation = yield* saveOk(`export const meta = { name: "Limited" } as const;
function hello(): string { return "hi"; }
export default workflow(async (w) => {
  console.log("starting");
  await w.notify("Hi", "there", { importance: "low" });
  return await w.run("Say hi", hello);
});`);
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;

      const detail = yield* engine.getRun(run.id);
      const fix = "Save the automation again from a thread in full-access mode.";
      expect(detail.run).toMatchObject({
        status: "failed",
        errorDetail: { why: null, fix, link: null },
      });
      expect(detail.steps[1]).toMatchObject({ status: "failed", errorDetail: { fix } });

      const directory = path.join(config.stateDir, "logs", "automations");
      const files = (yield* fs.readDirectory(directory)).filter((file) => file.endsWith(".jsonl"));
      const lines = (yield* Effect.forEach(files, (file) =>
        fs.readFileString(path.join(directory, file)),
      ))
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const events = lines.filter((event) => event.requestId === run.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "error",
        service: "signalbox-automations",
        outcome: "failed",
        automation: { id: automation.id, name: "Limited", version: 1 },
        run: { id: run.id, trigger: "manual", depth: 0 },
        steps: {
          s1: { verb: "notify", status: "succeeded", attempt: 1 },
          s2: { verb: "run", label: "Say hi", status: "failed", error: { fix } },
        },
        error: { fix },
      });
      expect(events[0]?.console).toEqual([`${run.startedAt} log starting`]);
    }),
  ),
);
