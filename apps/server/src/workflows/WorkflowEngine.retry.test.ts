import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  PROJECT,
  fakeHttp,
  fakeTools,
  jsonResponse,
  saveOk,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

/** Counts calls per URL; `b.example` hangs the first time and answers after. */
const routes = Effect.gen(function* () {
  const calls: Record<string, number> = {};
  const hanging = yield* Deferred.make<void>();
  const count = (url: string) => (calls[url] = (calls[url] ?? 0) + 1);
  const http = fakeHttp({
    "https://a.example/": () => Effect.sync(() => jsonResponse({ n: count("a") })),
    "https://b.example/": () =>
      count("b") === 1
        ? Deferred.succeed(hanging, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(jsonResponse({ ok: true })),
  });
  return { calls, hanging, http };
});

const automation = (body: string) => `export const meta = { name: "Fetcher" } as const;
export default workflow(async (w) => { ${body} });`;

it.effect("a retry reuses the steps that went well and runs the rest again", () =>
  Effect.gen(function* () {
    const { calls, hanging, http } = yield* routes;
    yield* withEngine(
      { http },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        // The label depends on when the run started, which a retry keeps.
        const saved = yield* saveOk(
          `export const meta = { name: "Fetcher" } as const;
export default workflow(async (w, input, trigger: { at: string }) => {
  const a = await w.http(\`Fetch A \${trigger.at}\`, "https://a.example/");
  await w.http("Fetch B", "https://b.example/");
  return a.body;
});`,
        );
        const original = yield* engine.startRun({ automationId: saved.id, trigger: "manual" });
        yield* Deferred.await(hanging);
        yield* engine.cancelRun(original.id);
        yield* engine.drain;
        expect((yield* engine.retryRun({ runId: "missing" }).pipe(Effect.flip)).message).toContain(
          "doesn't exist",
        );

        yield* TestClock.adjust("1 hour");
        const retry = yield* engine.retryRun({ runId: original.id });
        expect(retry.retryOf).toBe(original.id);
        yield* engine.drain;
        const detail = yield* engine.getRun(retry.id);
        expect(detail.run.status).toBe("succeeded");
        expect(detail.output).toEqual({ n: 1 });
        expect(calls).toEqual({ a: 1, b: 2 });
        const before = (yield* engine.getRun(original.id)).steps[0]!;
        expect(detail.steps[0]).toMatchObject({
          label: before.label,
          finishedAt: before.finishedAt,
        });

        const running = yield* saveOk(
          `export const meta = { name: "Asker" } as const;
export default workflow(async (w) => { await w.ask("Hold", {}); });`,
        );
        const busy = yield* engine.startRun({ automationId: running.id, trigger: "manual" });
        yield* engine.drain;
        expect((yield* engine.retryRun({ runId: busy.id }).pipe(Effect.flip)).message).toContain(
          "Only a failed or cancelled run",
        );
      }),
    );
  }),
);

it.effect("a retry captures its own event cursor and reruns later successful reads", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const tools = fakeTools({
        pull_request_read: {
          repository: "acme/app",
          number: 12,
          title: "Fix login",
          state: "open",
          headSha: "abc1234",
          isDraft: false,
          mergeability: "mergeable",
          reviewDecision: null,
          checks: [],
          openThreads: 0,
          files: [],
        },
      });
      yield* engine.registerBuiltinTools(tools.handler);
      const saved = yield* saveOk(`export const meta = { name: "Cursor retry" } as const;
export default workflow(async (w) => {
  await w.waitFor("Wait for the prior event", { on: "pr.opened" });
  const after = await w.eventCursor("Capture before reading the PR");
  const pr = await w.call("Read the pull request", "signalbox.pull_request_read", {
    threadId: "thread-9",
    url: "https://github.com/acme/app/pull/12",
  });
  const fresh = await w.waitFor("Wait for a fresh check", { on: "pr.checks.passed", after });
  return { state: pr.state, eventId: fresh.id };
});`);
      const original = yield* engine.startRun({ automationId: saved.id, trigger: "manual" });
      const deliver = (id: string, event: "pr.opened" | "pr.checks.passed") =>
        engine.deliverEvent({
          event,
          id,
          at: "2026-10-17T20:16:20.000Z",
          projectId: PROJECT,
          fields: Effect.succeed({ repository: "acme/app", number: 12 }),
        });

      yield* engine.drain;
      yield* deliver("original-opened", "pr.opened");
      yield* engine.drain;
      const beforeRetry = yield* engine.getRun(original.id);
      expect(beforeRetry.run.status).toBe("running");
      expect(beforeRetry.steps.find((step) => step.verb === "eventCursor")?.result).toEqual({
        runId: original.id,
        sequence: 1,
      });
      expect(tools.calls.filter((call) => call.tool === "pull_request_read")).toHaveLength(1);

      yield* engine.cancelRun(original.id);
      yield* engine.drain;
      const retry = yield* engine.retryRun({ runId: original.id });
      yield* engine.drain;

      const retried = yield* engine.getRun(retry.id);
      expect(retried.run.error).toBeNull();
      expect(retried.run.status).toBe("running");
      expect(retried.steps.find((step) => step.verb === "eventCursor")?.result).toEqual({
        runId: retry.id,
        sequence: 0,
      });
      expect(tools.calls.filter((call) => call.tool === "pull_request_read")).toHaveLength(2);

      yield* deliver("fresh-check", "pr.checks.passed");
      yield* engine.drain;
      expect(yield* engine.getRun(retry.id)).toMatchObject({
        run: { status: "succeeded" },
        output: { state: "open", eventId: "fresh-check" },
      });
    }),
  ),
);

it.effect("a retry on the latest version reuses only the steps whose call sites still match", () =>
  Effect.gen(function* () {
    const { calls, http } = yield* routes;
    yield* withEngine(
      { http },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const saved = yield* saveOk(
          automation(`await w.http("Fetch A", "https://a.example/");
  throw new Error("Forgot step B");`),
        );
        const original = yield* engine.startRun({ automationId: saved.id, trigger: "manual" });
        yield* engine.drain;
        expect((yield* engine.getRun(original.id)).run.status).toBe("failed");

        // The fix adds a step after the one that worked.
        yield* saveOk(
          automation(`const a = await w.http("Fetch A", "https://a.example/");
  await w.http("Fetch C", "https://c.example/");
  return a.body;`),
        );
        const same = yield* engine.retryRun({ runId: original.id });
        yield* engine.drain;
        expect((yield* engine.getRun(same.id)).run).toMatchObject({ version: 1, status: "failed" });

        const fixed = yield* engine.retryRun({ runId: original.id, version: "latest" });
        yield* engine.drain;
        expect((yield* engine.getRun(fixed.id)).run).toMatchObject({
          version: 2,
          status: "succeeded",
        });
        expect(calls.a).toBe(1);

        // A step inserted before it shifts the call sites: nothing after the change is reused.
        yield* saveOk(
          automation(`await w.http("Fetch Z", "https://z.example/");
  const a = await w.http("Fetch A", "https://a.example/");
  return a.body;`),
        );
        const shifted = yield* engine.retryRun({ runId: original.id, version: "latest" });
        yield* engine.drain;
        const detail = yield* engine.getRun(shifted.id);
        expect(detail.run.status).toBe("succeeded");
        expect(detail.output).toEqual({ n: 2 });
        expect(calls.a).toBe(2);
      }),
    );
  }),
);
