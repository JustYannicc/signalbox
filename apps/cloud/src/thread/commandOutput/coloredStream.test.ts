import { type OrchestrationV2CommandOutputFrame } from "@t3tools/contracts";
import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
} from "@t3tools/client-runtime/state/command-output";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { freshDatabase, owner, withObject } from "../runner/runnerTestKit.ts";
import { delta, firstFrame, reportCommand, start, target } from "./testKit.ts";

describe("colored command output streaming", () => {
  it.effect("appends colored growth and replaces cursor rewrites with identical client state", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        yield* batch(2, [delta(turn.runId, "\u001b[31mred\u001b[0m\n")]);
        const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
        const stream = yield* engine.commandOutput(owner, target);
        const collecting = yield* stream.pipe(
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkChild,
        );
        const initial = yield* Queue.take(frames);
        expect(initial.kind).toBe("replace");
        let client = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, initial);

        yield* batch(3, [delta(turn.runId, "\u001b[32mgreen\u001b[0m\n")]);
        yield* TestClock.adjust(500);
        const growth = yield* Queue.take(frames);
        expect(growth.kind).toBe("append");
        expect(growth.text).toContain("\u001b[");
        client = applyCommandOutputFrame(client, growth);
        expect(client).toEqual(
          applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, yield* firstFrame(engine)),
        );

        yield* batch(4, [delta(turn.runId, "\u001b[")]);
        yield* TestClock.adjust(500);
        const pending = yield* Queue.take(frames);
        expect(pending.kind).toBe("append");
        client = applyCommandOutputFrame(client, pending);
        expect(client).toEqual(
          applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, yield* firstFrame(engine)),
        );

        yield* batch(5, [delta(turn.runId, "1A\r\u001b[2K\u001b[34mrewritten\u001b[0m\n")]);
        yield* TestClock.adjust(500);
        const rewrite = yield* Queue.take(frames);
        expect(rewrite.kind).toBe("replace");
        client = applyCommandOutputFrame(client, rewrite);
        expect(client).toEqual(
          applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, yield* firstFrame(engine)),
        );

        yield* batch(6, [delta(turn.runId, "\u001b[33mlast\u001b[0m\n")]);
        yield* TestClock.adjust(500);
        const lastGrowth = yield* Queue.take(frames);
        expect(lastGrowth.kind).toBe("append");
        client = applyCommandOutputFrame(client, lastGrowth);
        expect(client).toEqual(
          applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, yield* firstFrame(engine)),
        );

        yield* batch(7, [reportCommand(turn.runId, { ...command, status: "completed" })]);
        yield* TestClock.adjust(500);
        const final = yield* Queue.take(frames);
        expect(final).toMatchObject({ kind: "replace", running: false });
        client = applyCommandOutputFrame(client, final);
        expect(client).toEqual(
          applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, yield* firstFrame(engine)),
        );
        yield* Fiber.join(collecting);
      }),
    ),
  );
});
