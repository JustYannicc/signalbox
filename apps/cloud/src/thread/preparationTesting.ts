import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import type { WorktreeSetupCancelInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  fakeSocket,
  hello,
  hostFor,
  launch,
  owner,
  threadId,
  withObject,
} from "./runnerTesting.ts";
import { onRunnerMessage, pushRunnerWork } from "./runner/runnerSockets.ts";
import type * as ThreadEngine from "./ThreadEngine.ts";
import { PullRequestSync } from "./pullRequests/PullRequestSync.ts";
import { makeThreadObjectApi } from "./threadObjectApi.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const preparationApi = (
  context: Parameters<Parameters<typeof withObject>[1]>[2],
  afterChange: () => Promise<void>,
) =>
  makeThreadObjectApi(
    Effect.runPromiseWith(
      Context.add(context, PullRequestSync, {
        sync: Effect.succeed(null),
        dueAt: Effect.succeed(null),
        requestSync: () => Effect.succeed(null),
        holdsTurn: Effect.succeed(false),
      }),
    ),
    afterChange,
    async () => {},
  );

export const loadingPreparation = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("No machine request");
    const socket = fakeSocket();
    const host = yield* hostFor(runner, [socket.socket]);
    const say = (message: object) =>
      encodeJson(message).pipe(
        Effect.flatMap((body) => Effect.promise(() => onRunnerMessage(host, socket.socket, body))),
      );
    yield* say({
      ...hello(plan.ensure.generation, plan.ensure.token),
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    });
    const start = socket.sent.find((frame) => frame.type === "turn.start");
    if (start?.type !== "turn.start" || start.turn.preparationGeneration === undefined)
      throw new Error("No v7 preparation");
    const target = {
      threadId,
      runId: start.turn.runId,
      preparationGeneration: start.turn.preparationGeneration,
    };
    socket.sent.length = 0;
    return {
      target,
      socket,
      host,
      say,
      turn: start.turn,
      generation: plan.ensure.generation,
      pushWork: () => pushRunnerWork(host),
    };
  });

export const requestCancellation = (
  engine: ThreadEngine.ThreadEngine["Service"],
  target: WorktreeSetupCancelInput,
) =>
  Effect.gen(function* () {
    const changes = yield* engine.subscribePreparation(owner);
    const cancelled = yield* engine.cancelPreparation(owner, target).pipe(Effect.forkChild);
    yield* changes.pipe(
      Stream.filter(
        (value) => value?.cancellationRequested === true || value?.phase === "cancelled",
      ),
      Stream.take(1),
      Stream.runDrain,
    );
    return cancelled;
  });
