import type {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadDirectory from "../ThreadDirectory.ts";
import * as CloudTerminals from "../CloudTerminals.ts";
import * as CloudTerminalsLayer from "../CloudTerminalsLayer.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const attachInput: TerminalAttachInput = { threadId: "thread-1", terminalId: "term-1" };
const snapshot: TerminalSessionSnapshot = {
  generation: 4,
  threadId: "thread-1",
  terminalId: "term-1",
  cwd: "/scratch",
  worktreePath: null,
  status: "running",
  pid: 100,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "",
  updatedAt: "2026-10-17T00:00:00.000Z",
  sequence: 0,
};

describe("CloudTerminals.attach", () => {
  it.effect("observes after the first snapshot when reconnecting a closed terminal stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const observeArguments: Array<boolean> = [];
        const terminalAttach: ThreadDirectory.ThreadHandle["terminalAttach"] = (
          _actor,
          _input: TerminalAttachInput,
          observe,
        ) => {
          observeArguments.push(observe);
          const event: TerminalAttachStreamEvent = {
            type: "snapshot",
            snapshot: observe ? { ...snapshot, status: "exited", pid: null } : snapshot,
          };
          return observe
            ? Stream.make(event)
            : Stream.concat(
                Stream.make(event),
                Stream.fail(
                  new ThreadDirectory.ThreadObjectError({
                    operation: "terminal.attach",
                    cause: "thread object closed after the snapshot",
                  }),
                ),
              );
        };
        const handle = { terminalAttach } as unknown as ThreadDirectory.ThreadHandle;
        const directory = Layer.succeed(ThreadDirectory.ThreadDirectory, {
          forThread: () => handle,
        });
        const services = yield* Layer.build(
          CloudTerminalsLayer.layer.pipe(Layer.provide(directory)),
        );
        const terminals = Context.get(services, CloudTerminals.CloudTerminals);
        const firstSnapshot = yield* Deferred.make<void>();
        const stream = terminals.attach(actor, attachInput, false);
        const collected = yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(firstSnapshot, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Deferred.await(firstSnapshot);
        yield* TestClock.adjust(250);
        const events = yield* Fiber.join(collected);
        expect(events.map((event) => event.type)).toEqual(["snapshot", "snapshot"]);
        expect(events[1]).toMatchObject({ snapshot: { generation: 4, status: "exited" } });
        expect(observeArguments).toEqual([false, true]);
      }),
    ),
  );
});
