import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ThreadEngine } from "../ThreadEngine.ts";
import type { ThreadRunner } from "../runner/ThreadRunner.ts";
import {
  claudeDriver,
  connect,
  encodeTurnItem,
  launch,
  liveTurn,
  now,
  owner,
  threadId,
  turnReport,
} from "../runnerTesting.ts";

export const itemId = TurnItemId.make("command-1");
export const target = { threadId, itemId };

export const commandItem = (
  turn: RunnerTurn,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> =>
  ({
    id: itemId,
    threadId,
    runId: turn.runId,
    nodeId: null,
    providerThreadId: turn.providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 7,
    status: "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "command_execution",
    input: "pnpm test",
    ...overrides,
  }) satisfies OrchestrationV2TurnItem;

export const providerItem = (
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  event: Record<string, unknown>,
): RunnerItem => ({ kind: "provider", runId, event: { driver: claudeDriver, ...event } });

export const reportCommand = (
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  item: OrchestrationV2TurnItem,
) => providerItem(runId, { type: "turn_item.updated", turnItem: encodeTurnItem(item) });

export const delta = (
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  chunk: string,
  extra: Record<string, unknown> = {},
) => providerItem(runId, { type: "command_output.delta", ...target, chunk, ...extra });

export const start = (engine: ThreadEngine["Service"], runner: ThreadRunner["Service"]) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    const command = commandItem(turn);
    const batch = (sequence: number, items: ReadonlyArray<RunnerItem>) =>
      runner.batch({ generation: machine.generation, sequence, items });
    yield* batch(1, [report.started, reportCommand(turn.runId, command)]);
    return { machine, turn, report, command, batch };
  });

export const firstFrame = (engine: ThreadEngine["Service"], input = target) =>
  Effect.gen(function* () {
    const stream = yield* engine.commandOutput(owner, input);
    const frames = yield* stream.pipe(Stream.take(1), Stream.runCollect);
    return frames[0]!;
  });
