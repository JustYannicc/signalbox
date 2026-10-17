import { describe, expect, it } from "@effect/vitest";
import { initLogger, type WideEvent } from "evlog";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  FINALIZE_GRACE_MS,
  TurnReports,
  claude,
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../thread/testing.ts";
import * as Evlog from "./Evlog.ts";

/**
 * #285's promise for the cloud: a turn's wide events say who, where and how
 * much, and nothing anyone wrote. The prompt and the reply are canaries; no
 * event that reaches a drain may carry either.
 */

const PROMPT = "canary-prompt: draft the Q3 layoffs memo";
const REPLY = "canary-reply: here is the layoffs memo";

/** Every event a drain would get, after sampling and redaction. */
const captureEvents = () => {
  const events: Array<WideEvent> = [];
  initLogger({
    silent: true,
    drain: (context) => {
      events.push(context.event);
    },
  });
  return events;
};

const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

describe("cloud wide events", () => {
  it.effect("a turn's event carries its dimensions and none of its text", () => {
    const events = captureEvents();
    return withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const reports = Context.get(context, TurnReports);
        yield* launch(engine, "launch-1", personal, { text: PROMPT });
        const machine = yield* connect(runner);
        const live = yield* liveTurn(runner);
        const report = turnReport(live.runId, live.runOrdinal, live.providerThread, {
          replyText: REPLY,
        });
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.partial, report.full, report.terminal],
        });
        yield* TestClock.adjust(FINALIZE_GRACE_MS);
        yield* reports.finalize((yield* snapshot(engine)).projection, yield* nowMs);
        return live;
      }).pipe(
        // As an alarm runs it: every `Effect.log*` of the turn lands on this unit's event.
        Evlog.withUnit("thread.alarm", { thread: { id: threadId } }),
        Effect.provide(Evlog.layer),
      ),
    ).pipe(
      Effect.map((live) => {
        const turn = events.find((event) => event.action === "turn");
        expect(turn).toMatchObject({
          person: { id: owner.userId },
          thread: { id: threadId },
          turn: { id: live.runId, traceId: live.traceId, outcome: "completed" },
          provider: "claudeAgent",
          model: claude.model,
        });
        expect(events.some((event) => event.action === "thread.alarm")).toBe(true);
        const drained = JSON.stringify(events);
        expect(drained).not.toContain("canary-prompt");
        expect(drained).not.toContain("canary-reply");
      }),
    );
  });
});
