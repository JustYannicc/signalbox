import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import { fakeThreads, PROJECT, saveOk, withEngine } from "./WorkflowEngine.testkit.ts";

const AT = DateTime.makeUnsafe("2026-10-06T10:00:00.000Z");
let sequence = 0;
const eventId = () => `event-${++sequence}`;

const runUpdated = (threadId: string, status: string, runId = `${threadId}-run`) => ({
  id: eventId(),
  type: "run.updated",
  threadId,
  runId,
  occurredAt: AT,
  payload: {
    id: runId,
    threadId,
    ordinal: 1,
    status,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
    userMessageId: "message-1",
    startedAt: AT,
    completedAt: AT,
  },
});

const messageSent = (threadId: string, id: string, createdBy: string, text = "Ship it") => ({
  id: eventId(),
  type: "message.updated",
  threadId,
  occurredAt: AT,
  payload: {
    id,
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy,
    creationSource: "web",
    createdAt: AT,
    updatedAt: AT,
  },
});

const automation = (name: string, triggers: string, body = "return trigger;") =>
  `export const meta = { name: "${name}", triggers: ${triggers} } as const;
export default workflow(async (w, input: any, trigger: any) => {
${body}
});`;

const runsOf = (automationId: string) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    return (yield* engine.get(automationId)).runs;
  });

it.effect("a finished turn starts each automation listening for it, once per turn", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const finished = yield* saveOk(automation("On finish", `[{ on: "turn.finished" }]`));
      const failures = yield* saveOk(
        automation("On failure", `[{ on: "turn.*", where: { status: ["failed", "cancelled"] } }]`),
      );

      yield* threads.emit(runUpdated("thread-9", "completed"));
      // The same turn seen again (a later update of the finished run) doesn't start another run.
      yield* threads.emit(runUpdated("thread-9", "completed"));
      yield* engine.drain;

      const runs = yield* runsOf(finished.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: "event", status: "succeeded" });
      const detail = yield* engine.getRun(runs[0]!.id);
      expect(detail.input).toMatchObject({
        event: "turn.finished",
        id: "turn.finished:thread-9-run",
        projectId: PROJECT,
        threadId: "thread-9",
        runId: "thread-9-run",
        threadTitle: "Title of thread-9",
        status: "completed",
        provider: "claudeAgent",
        model: "claude-opus",
        lastMessage: "Fixed it in PR #12.",
        error: null,
        branch: "branch-of-thread-9",
      });
      expect(detail.output).toEqual({
        type: "event",
        event: "turn.finished",
        eventId: "turn.finished:thread-9-run",
      });
      expect(yield* runsOf(failures.id)).toHaveLength(0);

      yield* threads.emit(runUpdated("thread-9", "failed", "second-run"));
      yield* engine.drain;
      expect(yield* runsOf(failures.id)).toHaveLength(1);
      expect(yield* runsOf(finished.id)).toHaveLength(2);
    }),
  );
});

it.effect("scope, from and the automation-thread guard decide what triggers", () => {
  const threads = fakeThreads();
  threads.state.shells["thread-other"] = { projectId: "project-other" };
  threads.state.shells["thread-auto"] = { createdBy: "system" };
  threads.state.threadRuns["thread-auto"] = [
    {
      id: "thread-auto-run",
      ordinal: 1,
      status: "completed",
      userMessageId: "automation:run_1:s0:message",
    },
  ];
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const people = yield* saveOk(automation("People here", `[{ on: "message.sent" }]`));
      const agents = yield* saveOk(
        automation("Agents anywhere", `[{ on: "message.sent", from: "agents", scope: "all" }]`),
      );
      const optedIn = yield* saveOk(
        automation("Every turn", `[{ on: "turn.finished", includeAutomationThreads: true }]`),
      );
      const guarded = yield* saveOk(automation("Human turns", `[{ on: "turn.finished" }]`));

      yield* threads.emit(messageSent("thread-1", "m-person", "user"));
      yield* threads.emit(messageSent("thread-other", "m-agent", "agent"));
      yield* threads.emit(messageSent("thread-1", "m-system", "system"));
      yield* threads.emit(runUpdated("thread-auto", "completed"));
      yield* engine.drain;

      const peopleRuns = yield* runsOf(people.id);
      expect(peopleRuns).toHaveLength(1);
      expect((yield* engine.getRun(peopleRuns[0]!.id)).input).toMatchObject({
        event: "message.sent",
        author: "person",
        text: "Ship it",
        attachments: 0,
      });
      const agentRuns = yield* runsOf(agents.id);
      expect(agentRuns).toHaveLength(1);
      expect((yield* engine.getRun(agentRuns[0]!.id)).input).toMatchObject({
        projectId: "project-other",
        author: "agent",
      });
      expect(yield* runsOf(optedIn.id)).toHaveLength(1);
      expect(yield* runsOf(guarded.id)).toHaveLength(0);
    }),
  );
});

it.effect("an automation's runs trigger other automations, never itself", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const fails = yield* saveOk(
        automation("Fails", `[{ on: "automation.run.failed" }]`, `throw new Error("boom");`),
      );
      const watcher = yield* saveOk(
        automation(
          "Watcher",
          `[{ on: "automation.run.failed", where: { automationName: "Fails" } }]`,
        ),
      );
      yield* engine.startRun({ automationId: fails.id, trigger: "manual" });
      yield* engine.drain;

      expect(yield* runsOf(fails.id)).toHaveLength(1);
      const runs = yield* runsOf(watcher.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: "event", status: "succeeded" });
      const input = (yield* engine.getRun(runs[0]!.id)).input as Record<string, unknown>;
      expect(input).toMatchObject({
        event: "automation.run.failed",
        automationId: fails.id,
        automationName: "Fails",
        projectId: PROJECT,
      });
      expect(String(input.error)).toContain("boom");
    }),
  ),
);

it.effect("too many event runs in a minute pause the event triggers until it's switched", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const noisy = yield* saveOk(
        automation("Noisy", `[{ on: "message.sent", maxRunsPerMinute: 2 }]`),
      );
      const notices = yield* engine.subscribeNotices;
      const paused = yield* Stream.runHead(
        Stream.filter(notices, (notice) => notice.automationId === noisy.id),
      ).pipe(Effect.forkScoped);

      for (const id of ["m1", "m2", "m3", "m4"])
        yield* threads.emit(messageSent("thread-1", id, "user"));
      yield* engine.drain;
      expect(yield* runsOf(noisy.id)).toHaveLength(2);
      expect(Option.getOrUndefined(yield* Fiber.join(paused))).toMatchObject({
        kind: "failed",
        title: "Noisy",
        body: expect.stringContaining("paused"),
      });

      yield* engine.setEnabled(noisy.id, false);
      yield* engine.setEnabled(noisy.id, true);
      yield* threads.emit(messageSent("thread-1", "m5", "user"));
      yield* engine.drain;
      expect(yield* runsOf(noisy.id)).toHaveLength(3);
    }).pipe(Effect.scoped),
  );
});

it.effect("a cron firing doesn't lift an event-trigger pause", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const both = yield* saveOk(
        automation("Both", `[{ cron: "* * * * *" }, { on: "message.sent", maxRunsPerMinute: 2 }]`),
      );
      for (const id of ["m1", "m2", "m3"]) yield* threads.emit(messageSent("thread-1", id, "user"));
      yield* engine.drain;
      expect(yield* runsOf(both.id)).toHaveLength(2);

      yield* TestClock.adjust("1 minute");
      yield* engine.tick;
      yield* engine.drain;
      const runs = yield* runsOf(both.id);
      expect(runs.map((run) => run.trigger).toSorted()).toEqual(["cron", "event", "event"]);

      // Still paused, though the minute that counted the runs is over.
      yield* threads.emit(messageSent("thread-1", "m4", "user"));
      yield* engine.drain;
      expect(yield* runsOf(both.id)).toHaveLength(3);
    }),
  );
});
