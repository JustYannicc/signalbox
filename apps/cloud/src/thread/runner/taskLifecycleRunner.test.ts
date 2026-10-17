import { CLAUDE_STREAM_PREFIX } from "@signalbox/runner-protocol/SessionProtocol";
import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as SessionRows from "../session/SessionRows.ts";
import { threadEvent } from "../threadEvents.ts";
import type * as ThreadEngine from "../ThreadEngine.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";
import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";

const markSettled = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  engine.apply((projection, ctx) => {
    if (projection === null) throw new Error("launched thread missing");
    return Effect.succeed({
      events: [
        threadEvent(ctx, "thread.settled", {
          ...projection.thread,
          archivedAt: ctx.now,
          settledOverride: "settled",
          settledAt: ctx.now,
          updatedAt: ctx.now,
        }),
      ],
      result: undefined,
    });
  });

describe("ThreadRunner task lifecycle", () => {
  it.effect(
    "drains an archived thread without its idle tail or preview, then preserves saved sessions",
    () =>
      withObject(
        freshDatabase(),
        (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started, report.full, report.terminal],
            });
            yield* engine.dispatch(
              owner,
              {
                type: "thread.archive",
                commandId: CommandId.make("archive-after-turn"),
                threadId,
              },
              personal,
            );

            const drain = yield* runner.reconcile;
            expect(drain).toMatchObject({
              drain: { generation: machine.generation },
              release: null,
              stop: false,
            });
            const drainId = drain.drain!.id;
            yield* saveSession(context, "claude-session-1");
            expect((yield* runner.work).drain).toBe(drainId);
            expect(yield* runner.reconcile).toMatchObject({
              release: null,
              drain: null,
              stop: false,
            });
            yield* runner.batch({
              generation: machine.generation,
              sequence: 2,
              items: [{ kind: "machine.drained", id: drainId, unsaved: [] }],
            });

            expect(yield* runner.reconcile).toMatchObject({
              release: machine.generation,
              stop: true,
            });
            expect(yield* runner.leaseToken(machine.generation)).toBeNull();
            expect(
              yield* Context.get(context, SessionRows.SessionRows).streams(CLAUDE_STREAM_PREFIX),
            ).toMatchObject([{ stream: `${CLAUDE_STREAM_PREFIX}claude-session-1`, count: 1 }]);
          }),
        { previews: { held: true, lastActiveAt: 0 } },
      ),
  );

  it.effect("cancels a settlement drain when a new message reopens the task", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* markSettled(engine);
        expect((yield* snapshot(engine)).projection.thread.archivedAt).not.toBeNull();

        const drain = yield* runner.reconcile;
        expect(drain.drain?.generation).toBe(machine.generation);
        yield* send(engine, 2, "Please continue");
        expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null, stop: false });
        expect((yield* runner.work).drain).toBeNull();
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
        });

        expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null, stop: false });
        const reopenedWork = yield* runner.work;
        expect(reopenedWork.drain).toBeNull();
        expect(reopenedWork.turn?.message.text).toContain("Please continue");
        const { projection } = yield* snapshot(engine);
        expect(projection.thread.settledOverride).toBeNull();
        expect(projection.thread.settledAt).toBeNull();
        expect(projection.thread.archivedAt).toBeNull();
      }),
    ),
  );

  it.effect("retains a settled machine after an incomplete save and retries the drain", () =>
    withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-10-17T00:00:00Z"));
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          yield* markSettled(engine);

          const firstDrain = yield* runner.reconcile;
          const firstId = firstDrain.drain!.id;
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [{ kind: "machine.drained", id: firstId, unsaved: ["session write failed"] }],
          });
          expect((yield* runner.work).needsUpkeep).toBe(true);

          // Unsaved work keeps the machine: after the drain interval it is asked again, not released.
          yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
          const retry = yield* runner.reconcile;
          expect(retry).toMatchObject({ release: null, stop: false });
          expect(retry.drain?.id).toBeGreaterThan(firstId);
          expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
          yield* saveSession(context, "claude-session-1");
          yield* runner.batch({
            generation: machine.generation,
            sequence: 3,
            items: [{ kind: "machine.drained", id: retry.drain!.id, unsaved: [] }],
          });

          expect(yield* runner.reconcile).toMatchObject({
            release: machine.generation,
            stop: true,
          });
          expect(
            yield* Context.get(context, SessionRows.SessionRows).streams(CLAUDE_STREAM_PREFIX),
          ).toMatchObject([{ stream: `${CLAUDE_STREAM_PREFIX}claude-session-1`, count: 1 }]);
        }),
      { previews: { held: true, lastActiveAt: 0 } },
    ),
  );

  it.effect("keeps a settled machine on a missing drain ack and retries after a deadline", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-17T01:00:00Z"));
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* markSettled(engine);

        const drain = yield* runner.reconcile;
        expect(drain.drain?.generation).toBe(machine.generation);
        yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
        // An unanswered drain never lets a settled machine go: it is asked again.
        const retry = yield* runner.reconcile;
        expect(retry).toMatchObject({ release: null, stop: false });
        expect(retry.drain?.id).toBe(drain.drain!.id + DRAIN_TIMEOUT_MS);
        expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
      }),
    ),
  );
});
