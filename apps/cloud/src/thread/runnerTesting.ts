import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadRunner from "./runner/ThreadRunner.ts";
import { claude, hello, liveTurn, turnReport } from "./runner/runnerTestKit.ts";

export const claudeModelSelection = claude;

export interface RunnerConnection {
  readonly generation: number;
  readonly connection: number;
}

const connect = (runner: ThreadRunner.ThreadRunner["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);
    const welcome = yield* runner.hello({
      ...hello(plan.ensure.generation, plan.ensure.token),
      threadId,
    });
    if (welcome._tag !== "welcome") {
      throw new Error(`Runner refused ${welcome.reason}: ${welcome.message}`);
    }
    return { generation: welcome.generation, connection: welcome.connection };
  });

/** Keep tests in other Cloud modules off the Runner's private implementation. */
export const connectRunner = (threadId: ThreadId) =>
  ThreadRunner.ThreadRunner.use((runner) => connect(runner, threadId));

export const currentRunId = () =>
  ThreadRunner.ThreadRunner.use((runner) => Effect.map(liveTurn(runner), (turn) => turn.runId));

export const finishCurrentTurn = (generation: number) =>
  ThreadRunner.ThreadRunner.use((runner) =>
    Effect.gen(function* () {
      const turn = yield* liveTurn(runner);
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
      yield* runner.batch({ generation, sequence: 1, items: [report.started] });
      yield* runner.batch({ generation, sequence: 2, items: [report.partial] });
      yield* runner.batch({ generation, sequence: 3, items: [report.full, report.terminal] });
    }),
  );

export const disconnectDuringCurrentTurn = (connection: RunnerConnection, detail: string) =>
  ThreadRunner.ThreadRunner.use((runner) =>
    Effect.gen(function* () {
      const turn = yield* liveTurn(runner);
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
      yield* runner.batch({
        generation: connection.generation,
        sequence: 4,
        items: [report.started, report.partial],
      });
      yield* runner.disconnected({ ...connection, detail });
    }),
  );

export const replaceRunner = (threadId: ThreadId, generation: number) =>
  ThreadRunner.ThreadRunner.use((runner) =>
    Effect.gen(function* () {
      yield* runner.ended(generation, "test replacement");
      return yield* connect(runner, threadId);
    }),
  );
