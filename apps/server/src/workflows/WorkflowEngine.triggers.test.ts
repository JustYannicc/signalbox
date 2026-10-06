// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import { expect, it } from "@effect/vitest";
import { AutomationError, ProjectId, type Automation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import {
  DEFAULTS,
  PROJECT,
  fakeHttp,
  jsonResponse,
  saveOk,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

const OTHER_PROJECT = ProjectId.make("project-other");

const source = (name: string, body: string, meta = "") =>
  `export const meta = { name: "${name}"${meta} } as const;\nexport default workflow(async (w, input: any, trigger: any) => {\n${body}\n});`;

it.effect("names are unique per project, and saving never moves an automation", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const ours = yield* saveOk(source("Report", "return 1;"));
      const theirs = yield* saveOk(source("Report", "return 2;"), { projectId: OTHER_PROJECT });
      expect(theirs.id).not.toBe(ours.id);
      expect((yield* engine.get(ours.id)).automation.projectId).toBe(PROJECT);

      const moved = yield* engine
        .save({
          source: source("Report", "return 3;"),
          automationId: ours.id,
          projectId: OTHER_PROJECT,
          defaults: DEFAULTS,
        })
        .pipe(Effect.flip);
      expect(moved.message).toContain("belongs to another project");
      expect((yield* engine.get(ours.id)).automation).toMatchObject({
        projectId: PROJECT,
        version: 1,
      });
    }),
  ),
);

it.effect("saving over or running an automation goes past its authorize check", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const seen: string[] = [];
      const refuse = (current: { runtimeMode: string }) =>
        Effect.suspend(() => {
          seen.push(current.runtimeMode);
          return Effect.fail(new AutomationError({ message: "Not from this thread." }));
        });
      // A new automation has nothing to check against.
      const created = yield* engine.save(
        {
          source: source("Guarded", "return 1;"),
          projectId: PROJECT,
          defaults: { ...DEFAULTS, runtimeMode: "full-access" },
        },
        refuse,
      );
      expect(created.ok).toBe(true);
      const update = yield* engine
        .save(
          { source: source("Guarded", "return 2;"), projectId: PROJECT, defaults: DEFAULTS },
          refuse,
        )
        .pipe(Effect.flip);
      expect(update.message).toBe("Not from this thread.");
      const automation = (yield* engine.list())[0]!;
      expect(automation.version).toBe(1);
      const run = yield* engine
        .startRun({ automationId: automation.id, trigger: "manual", authorize: refuse })
        .pipe(Effect.flip);
      expect(run.message).toBe("Not from this thread.");
      expect(seen).toEqual(["full-access", "full-access"]);
      expect((yield* engine.get(automation.id)).runs).toEqual([]);
    }),
  ),
);

it.effect("w.call only lets Executor auto-approve for full-access automations", () => {
  const http = fakeHttp({
    "https://executor.example/api/executions": (request) =>
      Effect.succeed(
        request.body._tag === "Uint8Array" &&
          new TextDecoder().decode(request.body.body).includes('"autoApprove":true')
          ? jsonResponse({
              status: "completed",
              structured: { status: "completed", result: { ok: true, value: "sent" } },
            })
          : jsonResponse({ status: "paused", text: "Approve sending mail?" }),
      ),
  });
  return withEngine(
    {
      http,
      environment: {
        ...NodeProcess.env,
        SIGNALBOX_EXECUTOR_URL: "https://executor.example",
        SIGNALBOX_EXECUTOR_API_KEY: "server-secret",
      },
    },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const body = 'return await w.call("Send", "gmail.users.messages.send", {});';
      const limited = yield* saveOk(source("Limited", body));
      const trusted = yield* saveOk(source("Trusted", body), {
        defaults: { ...DEFAULTS, runtimeMode: "full-access" },
      });
      const limitedRun = yield* engine.startRun({ automationId: limited.id, trigger: "manual" });
      const trustedRun = yield* engine.startRun({ automationId: trusted.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(limitedRun.id)).run).toMatchObject({
        status: "failed",
        error:
          "This call needs approval in Executor; save this automation from a full-access thread to allow it.",
      });
      expect(yield* engine.getRun(trustedRun.id)).toMatchObject({
        run: { status: "succeeded" },
        output: "sent",
      });
    }),
  );
});

it.effect("w.call retries Executor being down, with the same idempotency key", () => {
  let calls = 0;
  const http = fakeHttp({
    "https://executor.example/api/executions": () =>
      Effect.sync(() =>
        ++calls === 1
          ? jsonResponse({ text: "Bad gateway" }, { status: 502 })
          : jsonResponse({
              status: "completed",
              structured: { status: "completed", result: { ok: true, value: ["inbox"] } },
            }),
      ),
  });
  return withEngine(
    {
      http,
      environment: {
        ...NodeProcess.env,
        SIGNALBOX_EXECUTOR_URL: "https://executor.example",
        SIGNALBOX_EXECUTOR_API_KEY: "server-secret",
      },
    },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(
        source("Labels", 'return await w.call("Read", "gmail.users.labels.list", {});'),
      );
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).steps[0]).toMatchObject({
        status: "waiting",
        attempt: 2,
        error: "Executor answered 502: Bad gateway",
      });
      yield* TestClock.adjust("5 seconds");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: ["inbox"],
      });
      expect(http.sent.map((request) => request.headers["idempotency-key"])).toEqual([
        `${run.id}/s1`,
        `${run.id}/s1`,
      ]);
    }),
  );
});

it.effect(
  "crons skip while a run is going, unless overlap allows it, and skip long-missed times",
  () =>
    withEngine(
      {},
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const cron = ', triggers: [{ cron: "* * * * *" }]';
        const skipping = yield* saveOk(source("Skips", 'await w.ask("Hold", {});', cron));
        const allowing = yield* saveOk(
          source("Overlaps", 'await w.ask("Hold", {});', `${cron}, overlap: "allow"`),
        );
        const runs = (automation: Automation) =>
          engine.get(automation.id).pipe(Effect.map((detail) => detail.runs.length));

        yield* TestClock.adjust("1 minute");
        yield* engine.tick;
        yield* engine.drain;
        yield* TestClock.adjust("1 minute");
        yield* engine.tick;
        yield* engine.drain;
        expect(yield* runs(skipping)).toBe(1);
        expect(yield* runs(allowing)).toBe(2);
      }),
    ),
);

it.effect("a cron missed by more than an hour is rescheduled, not run", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const automation = yield* saveOk(
        source("Hourly", "return 1;", ', triggers: [{ cron: "0 * * * *" }]'),
      );
      yield* TestClock.adjust("3 hours");
      // As if the server had been down since before 01:00.
      yield* sql`UPDATE signalbox_automations SET next_run_at = '1970-01-01T01:00:00.000Z'`;
      const before = (yield* engine.get(automation.id)).runs.length;
      yield* engine.tick;
      yield* engine.drain;
      const detail = yield* engine.get(automation.id);
      expect(detail.runs).toHaveLength(before);
      expect(detail.automation.nextRunAt).toBe("1970-01-01T04:00:00.000Z");
    }),
  ),
);

it.effect("webhooks dedupe repeated deliveries, pass headers along, and rotate tokens", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(
        source(
          "Hook",
          "return { input, event: trigger.headers['x-github-event'], raw: trigger.rawBody, type: trigger.type };",
          ", triggers: [{ webhook: true }]",
        ),
      );
      const token = automation.webhookPath!.split("/").at(-1)!;
      const deliver = (requestKey?: string) =>
        engine.startFromWebhook({
          token,
          payload: { a: 1 },
          headers: { "x-github-event": "push" },
          rawBody: '{"a":1}',
          ...(requestKey ? { requestKey } : {}),
        });
      const first = (yield* deliver("evt-1"))!;
      expect(first.duplicate).toBe(false);
      expect(yield* deliver("evt-1")).toEqual({ runId: first.runId, duplicate: true });
      const other = (yield* deliver("evt-2"))!;
      expect(other.runId).not.toBe(first.runId);
      yield* engine.drain;
      expect((yield* engine.getRun(first.runId)).output).toEqual({
        input: { a: 1 },
        event: "push",
        raw: '{"a":1}',
        type: "webhook",
      });

      // A day later the sender may reuse the id.
      yield* TestClock.adjust("25 hours");
      expect((yield* deliver("evt-1"))!.duplicate).toBe(false);

      const rotated = yield* engine.rotateWebhook(automation.id);
      expect(rotated.webhookPath).not.toBe(automation.webhookPath);
      expect(yield* deliver()).toBeNull();
      const fresh = rotated.webhookPath!.split("/").at(-1)!;
      expect(yield* engine.startFromWebhook({ token: fresh, payload: null })).not.toBeNull();
      yield* engine.setEnabled(automation.id, false);
      expect(yield* engine.startFromWebhook({ token: fresh, payload: null })).toBeNull();
    }),
  ),
);

it.effect("w.start refuses paused or more-privileged automations and stops runaway chains", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const failure = (automation: Automation) =>
        Effect.gen(function* () {
          const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
          yield* engine.drain;
          return (yield* engine.getRun(run.id)).run.error;
        });

      const paused = yield* saveOk(source("Paused", "return 1;"));
      yield* engine.setEnabled(paused.id, false);
      expect(
        yield* failure(
          yield* saveOk(source("Starts paused", 'await w.start("Go", "Paused", {});')),
        ),
      ).toBe('"Paused" is paused, so it can\'t be started.');
      // Running a paused automation by hand still works.
      const manual = yield* engine.startRun({ automationId: paused.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(manual.id)).run.status).toBe("succeeded");

      yield* saveOk(source("Powerful", "return 1;"), {
        defaults: { ...DEFAULTS, runtimeMode: "full-access" },
      });
      expect(
        yield* failure(
          yield* saveOk(source("Starts powerful", 'await w.start("Go", "Powerful", {});')),
        ),
      ).toBe(
        "\"Powerful\" runs with full-access access, more than this automation's approval-required, so it can't start it.",
      );

      const loop = yield* saveOk(source("Loop", 'await w.start("Again", "Loop", {});'));
      yield* engine.startRun({ automationId: loop.id, trigger: "manual" });
      yield* engine.drain;
      const runs = (yield* engine.get(loop.id)).runs;
      expect(runs).toHaveLength(6);
      expect(runs.filter((run) => run.status === "failed").map((run) => run.error)).toEqual([
        "w.start is nested 5 automations deep; an automation is probably starting itself in a loop.",
      ]);
    }),
  ),
);

it.effect("events only wake runs that are still going", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(
        source("Waits", 'return await w.waitFor("Reply", { event: "reply" });'),
      );
      const cancelled = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      const live = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      yield* engine.cancelRun(cancelled.id);
      expect(yield* engine.emit({ event: "reply", payload: "hi" })).toBe(1);
      yield* engine.drain;
      expect(yield* engine.getRun(live.id)).toMatchObject({ output: "hi" });
      expect((yield* engine.getRun(cancelled.id)).run.status).toBe("cancelled");
    }),
  ),
);

it.effect("list subscribers share one recompute per burst of changes", () =>
  withEngine(
    {},
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const first = yield* Queue.unbounded<ReadonlyArray<Automation>>();
        const second = yield* Queue.unbounded<ReadonlyArray<Automation>>();
        yield* Stream.runForEach(engine.subscribeList(), (list) => Queue.offer(first, list)).pipe(
          Effect.forkScoped,
        );
        yield* Stream.runForEach(engine.subscribeList(), (list) => Queue.offer(second, list)).pipe(
          Effect.forkScoped,
        );
        expect(yield* Queue.take(first)).toEqual([]);
        expect(yield* Queue.take(second)).toEqual([]);

        for (const name of ["A", "B", "C"]) yield* saveOk(source(name, "return 1;"));
        yield* TestClock.adjust("100 millis");
        const one = yield* Queue.take(first);
        const two = yield* Queue.take(second);
        expect(one.map((automation) => automation.name)).toEqual(["A", "B", "C"]);
        // The same computed list, not one per subscriber.
        expect(two).toBe(one);
      }),
    ),
  ),
);
