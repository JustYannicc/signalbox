// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import { expect, it } from "@effect/vitest";
import type { AutomationDefaults } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import {
  DEFAULTS,
  PROJECT,
  fakeHttp,
  fakeThreads,
  withEngine as withEngineOptions,
  acceptedRun,
  webhookRequest,
} from "./WorkflowEngine.testkit.ts";

const executor = fakeHttp();

function withEngine<A, E>(
  threads: ReturnType<typeof fakeThreads>,
  body: Effect.Effect<A, E, WorkflowEngine>,
  environment?: NodeJS.ProcessEnv,
) {
  return withEngineOptions(
    { threads, http: executor, ...(environment ? { environment } : {}) },
    body,
  );
}

const SOURCE = `
export const meta = { name: "Count things" } as const;

export default workflow(async (w) => {
  const count = (await w.recall("Last count", "count")) ?? 0;
  const page = await w.http("Fetch", "https://example.com/data");
  const choice = await w.ask("Go on?", { options: ["yes", "no"] });
  if (choice === "no") return "stopped";
  await w.sleep("Wait a bit", { minutes: 5 });
  await w.remember("Save count", "count", count + 1);
  return { count: count + 1, items: page.body.items };
});
`;

it.effect("runs an automation through questions, timers and memory", () => {
  const threads = fakeThreads();
  return withEngine(
    threads,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({ source: SOURCE, projectId: PROJECT, defaults: DEFAULTS });
      if (!saved.ok)
        throw new Error(saved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      expect(saved.automation).toMatchObject({ name: "Count things", enabled: true, version: 1 });

      const run = yield* engine.startRun({ automationId: saved.automation.id, trigger: "manual" });
      yield* engine.drain;
      let detail = yield* engine.getRun(run.id);
      expect(detail.run).toMatchObject({ status: "running", waitingOnYou: true });
      expect((yield* engine.list())[0]?.waiting).toMatchObject([
        { runId: run.id, label: "Go on?", question: null, options: ["yes", "no"] },
      ]);
      expect(detail.steps.map((step) => [step.label, step.status])).toEqual([
        ["Last count", "succeeded"],
        ["Fetch", "succeeded"],
        ["Go on?", "waiting"],
      ]);

      yield* engine.answer({ runId: run.id, stepKey: detail.steps[2]!.key, choice: "yes" });
      yield* engine.drain;
      detail = yield* engine.getRun(run.id);
      expect(detail.steps.at(-1)).toMatchObject({ label: "Wait a bit", status: "waiting" });

      yield* TestClock.adjust("6 minutes");
      yield* engine.tick;
      yield* engine.drain;
      detail = yield* engine.getRun(run.id);
      expect(detail.run.status).toBe("succeeded");
      expect(detail.output).toEqual({ count: 1, items: 3 });
      expect(detail.run.title).toBeNull();

      const second = yield* engine.startRun({
        automationId: saved.automation.id,
        trigger: "manual",
      });
      yield* engine.drain;
      const secondDetail = yield* engine.getRun(second.id);
      yield* engine.answer({ runId: second.id, stepKey: secondDetail.steps[2]!.key, choice: "no" });
      yield* engine.drain;
      expect(yield* engine.getRun(second.id)).toMatchObject({
        run: { status: "succeeded" },
        output: "stopped",
      });

      const listed = yield* engine.list();
      expect(listed[0]?.lastRun?.id).toBe(second.id);
    }),
  );
});

it.effect("waits for an agent thread and returns its final message", () => {
  const threads = fakeThreads();
  return withEngine(
    threads,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({
        source: `export const meta = { name: "Fix it" } as const;
export default workflow(async (w) => {
  const result = await w.agent("Fix the bug", { prompt: "Fix the flaky test.", worktree: "main" });
  return result.text;
});`,
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      if (!saved.ok)
        throw new Error(saved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const run = yield* engine.startRun({ automationId: saved.automation.id, trigger: "manual" });
      yield* engine.drain;
      expect(threads.launches).toHaveLength(1);
      expect(threads.launches[0]).toMatchObject({
        title: "Fix the bug",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
        initialMessage: { text: "Fix the flaky test." },
        modelSelection: DEFAULTS.modelSelection,
      });
      expect((yield* engine.getRun(run.id)).steps[0]).toMatchObject({
        status: "waiting",
        threadId: "thread-1",
      });

      yield* engine.tick;
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).run.status).toBe("running");

      threads.state.finished = true;
      yield* threads.runEnded("thread-1");
      yield* engine.drain;
      const ran = yield* engine.getRun(run.id);
      expect(ran.run.error).toBeNull();
      expect(ran).toMatchObject({
        run: { status: "succeeded" },
        output: "Fixed it in PR #12.",
      });
    }),
  );
});

it.effect("names an agent's branch and effort, and continues its thread", () => {
  const threads = fakeThreads();
  return withEngine(
    threads,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({
        source: `export const meta = { name: "Build and fix" } as const;
export default workflow(async (w) => {
  const built = await w.agent("Build it", {
    prompt: "Build #126.",
    worktree: { base: "main", branch: "cloud/126" },
    effort: "high",
  });
  const fixed = await w.agent("Fix CI", { prompt: "CI is red; fix it.", thread: built.threadId });
  return { built, fixed: fixed.text };
});`,
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      if (!saved.ok)
        throw new Error(saved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const run = yield* engine.startRun({ automationId: saved.automation.id, trigger: "manual" });
      yield* engine.drain;
      expect(threads.launches[0]).toMatchObject({
        workspaceStrategy: {
          type: "worktree",
          baseRef: "main",
          branch: "cloud/126",
          startFromOrigin: true,
        },
        modelSelection: { ...DEFAULTS.modelSelection, options: [{ id: "effort", value: "high" }] },
      });

      threads.state.finished = true;
      yield* threads.runEnded("thread-1");
      yield* engine.drain;
      // The first run of thread-1 is done, but the follow-up's own run is what the step waits on.
      expect(threads.state.sends).toEqual([
        { threadId: "thread-1", text: "CI is red; fix it.", runId: "sent-1" },
      ]);
      expect(threads.launches).toHaveLength(1);
      yield* engine.tick;
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).run.status).toBe("running");

      threads.state.replies["sent-1"] = "CI is green.";
      threads.state.finishedSends.add("sent-1");
      yield* threads.runEnded("thread-1", "sent-1");
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: {
          built: {
            text: "Fixed it in PR #12.",
            threadId: "thread-1",
            branch: "branch-of-thread-1",
            worktreePath: "/worktrees/thread-1",
            pullRequest: null,
          },
          fixed: "CI is green.",
        },
      });
    }),
  );
});

it.effect("returns compile errors instead of saving, and saving by name makes a new version", () =>
  withEngine(
    fakeThreads(),
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const broken = yield* engine.save({
        source: `export const meta = { name: "Broken" } as const;\nexport default workflow(async (w) => { await w.email("x", {}); });`,
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      expect(broken.ok).toBe(false);
      expect(yield* engine.list()).toEqual([]);

      const first = yield* engine.save({ source: SOURCE, projectId: PROJECT, defaults: DEFAULTS });
      const second = yield* engine.save({
        source: SOURCE.replace("Wait a bit", "Wait longer"),
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      expect(first.ok && second.ok && second.automation.id === first.automation.id).toBe(true);
      expect(second.ok && second.automation.version).toBe(2);
    }),
  ),
);

it.effect("runs model steps as plan-mode threads and branches on the judge's answer", () => {
  const threads = fakeThreads();
  return withEngine(
    threads,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({
        source: `export const meta = { name: "Triage", triggers: [{ webhook: true }] } as const;
export default workflow(async (w, issue: { title: string }) => {
  const kind = await w.judge("Bug or noise?", { input: issue, outcomes: ["bug", "noise"] });
  if (kind === "noise") return "ignored";
  return \`fixing \${issue.title}\`;
});`,
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      if (!saved.ok)
        throw new Error(saved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      expect(saved.automation.webhook?.path).toMatch(/^\/api\/hooks\/automation_[^/]+\/hook_/);

      expect(
        yield* engine.receiveWebhook(webhookRequest(saved.automation, { token: "wrong" })),
      ).toEqual({ _tag: "not_found" });
      const started = yield* acceptedRun(
        yield* engine.receiveWebhook(
          webhookRequest(saved.automation, { body: '{"title":"Login crash"}' }),
        ),
      );
      const run = { id: started.runId };
      yield* engine.drain;
      expect(threads.launches[0]).toMatchObject({
        interactionMode: "plan",
        title: "Bug or noise?",
      });
      expect(threads.launches[0]?.initialMessage?.text).toContain("Login crash");

      threads.state.reply = "**Bug**";
      threads.state.finished = true;
      yield* threads.runEnded("thread-1");
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded", trigger: "webhook" },
        output: "fixing Login crash",
      });
      expect((yield* engine.getRun(run.id)).run.title).toBe("fixing Login crash");
      expect(threads.state.dispatched).toContain("thread.settle");
    }),
  );
});

const RUN_SOURCE = `import { platform } from "node:os";

export const meta = { name: "Run code" } as const;

function describe(label: string, count: number): { text: string; os: string } {
  return { text: \`\${label} x\${count}\`, os: platform() };
}

export default workflow(async (w) => {
  return await w.run("Describe", describe, "pages", 3);
});`;

it.effect("runs a w.run function in a Node process, only for full-access automations", () =>
  withEngine(
    fakeThreads(),
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const save = (runtimeMode: AutomationDefaults["runtimeMode"], name: string) =>
        engine.save({
          source: RUN_SOURCE.replace("Run code", name),
          projectId: PROJECT,
          defaults: { ...DEFAULTS, runtimeMode },
        });

      const trusted = yield* save("full-access", "Run code");
      if (!trusted.ok)
        throw new Error(trusted.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const run = yield* engine.startRun({
        automationId: trusted.automation.id,
        trigger: "manual",
      });
      yield* engine.drain;
      const ran = yield* engine.getRun(run.id);
      expect(ran.run.error).toBeNull();
      expect(ran).toMatchObject({
        run: { status: "succeeded" },
        // `os` proves the function ran in Node with its node: import.
        output: { text: "pages x3", os: expect.stringMatching(/^[a-z0-9]+$/) },
      });

      const limited = yield* save("approval-required", "Run code limited");
      if (!limited.ok) throw new Error("expected save");
      const denied = yield* engine.startRun({
        automationId: limited.automation.id,
        trigger: "manual",
      });
      yield* engine.drain;
      const detail = yield* engine.getRun(denied.id);
      expect(detail.run.status).toBe("failed");
      expect(detail.run.error).toContain("full-access");
    }),
  ),
);

it.effect("calls connected services through Executor with the server's key", () =>
  withEngine(
    fakeThreads(),
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({
        source: `export const meta = { name: "Labels" } as const;
export default workflow(async (w) => {
  const labels = await w.call("Read labels", "gmail.users.labels.list", { userId: "me" }, { connection: "work" });
  return labels;
});`,
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      if (!saved.ok) throw new Error("expected save");
      const run = yield* engine.startRun({ automationId: saved.automation.id, trigger: "manual" });
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: { labels: ["home"] },
      });
      const request = executor.sent.at(-1)!;
      const sent = {
        authorization: request.headers.authorization,
        body: request.body as { code: string; autoApprove: boolean },
      };
      expect(sent.authorization).toBe("Bearer server-secret");
      // Saved from an approval-required thread: Executor's approvals still apply.
      expect(sent.body.autoApprove).toBe(false);
      expect(request.headers["idempotency-key"]).toBe(`${run.id}/s1`);
      expect(sent.body.code).toContain('c.integration === "gmail"');
      expect(sent.body.code).toContain('"work"');
      expect(sent.body.code).toContain("users.labels.list");
      expect(sent.body.code).not.toContain("server-secret");
    }),
    {
      ...NodeProcess.env,
      SIGNALBOX_EXECUTOR_URL: "https://executor.example",
      SIGNALBOX_EXECUTOR_API_KEY: "server-secret",
    },
  ),
);

it.effect("announces each waiting ask and each notify exactly once", () =>
  withEngine(
    fakeThreads(),
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const saved = yield* engine.save({
          source: `export const meta = { name: "Ship it" } as const;
export default workflow(async (w) => {
  const choice = await w.ask("Ship?", { question: "Ship v2 to prod?" });
  await w.notify("Shipped", \`Shipped: \${choice}\`, { importance: "low" });
  return choice;
});`,
          projectId: PROJECT,
          defaults: DEFAULTS,
        });
        if (!saved.ok) throw new Error("expected save");
        const notices = yield* engine.subscribeNotices;
        // Three notices across two runs: a repeat of any would take the second run's place.
        const collected = yield* Stream.runCollect(Stream.take(notices, 3)).pipe(Effect.forkScoped);

        const first = yield* engine.startRun({
          automationId: saved.automation.id,
          trigger: "manual",
        });
        yield* engine.drain;
        const ask = (yield* engine.getRun(first.id)).steps[0]!;
        yield* engine.answer({ runId: first.id, stepKey: ask.key, choice: "approve" });
        yield* engine.drain;
        const second = yield* engine.startRun({
          automationId: saved.automation.id,
          trigger: "manual",
        });
        yield* engine.drain;

        const seen = yield* Fiber.join(collected);
        expect(
          seen.map(({ kind, runId, title, body, importance }) => ({
            kind,
            runId,
            title,
            body,
            importance,
          })),
        ).toEqual([
          {
            kind: "ask",
            runId: first.id,
            title: "Ship it",
            body: "Ship v2 to prod?",
            importance: "high",
          },
          {
            kind: "notify",
            runId: first.id,
            title: "Ship it",
            body: "Shipped: approve",
            importance: "low",
          },
          {
            kind: "ask",
            runId: second.id,
            title: "Ship it",
            body: "Ship v2 to prod?",
            importance: "high",
          },
        ]);
        expect(seen[0]?.id).toBe(`${first.id}/${ask.key}`);
      }),
    ),
  ),
);
