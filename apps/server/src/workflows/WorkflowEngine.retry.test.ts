import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import { fakeHttp, jsonResponse, saveOk, withEngine } from "./WorkflowEngine.testkit.ts";

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
        // The label depends on the clock and randomness, which a retry replays as they were.
        const saved = yield* saveOk(
          automation(`const stamp = \`\${Date.now()} \${Math.random()}\`;
  const a = await w.http(\`Fetch A \${stamp}\`, "https://a.example/");
  await w.http("Fetch B", "https://b.example/");
  return a.body;`),
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
