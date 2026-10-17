import { type TerminalAttachStreamEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CloudTerminals from "./CloudTerminals.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import { ThreadObjectError } from "./ThreadAccess.ts";

type Failure = CloudTerminals.CloudTerminalError;

const make = Effect.gen(function* () {
  const directory = yield* ThreadDirectory.ThreadDirectory;
  return CloudTerminals.CloudTerminals.of({
    open: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalOpen(actor, input),
    write: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalWrite(actor, input),
    close: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalClose(actor, input),
    resize: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalResize(actor, input),
    clear: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalClear(actor, input),
    restart: (actor, input) =>
      directory.forThread(ThreadId.make(input.threadId)).terminalRestart(actor, input),
    attach: (actor, input, observe) =>
      Stream.unwrap(
        Effect.sync(() => {
          let failures = 0;
          let observing = observe;
          const attempt = (): Stream.Stream<TerminalAttachStreamEvent, Failure> =>
            directory
              .forThread(ThreadId.make(input.threadId))
              .terminalAttach(actor, input, observing)
              .pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    failures = 0;
                    if (event.type === "snapshot") observing = true;
                  }),
                ),
                Stream.concat(
                  Stream.fail(
                    new ThreadObjectError({
                      operation: "terminal.attach",
                      cause: "The thread object closed the terminal stream.",
                    }),
                  ),
                ),
                Stream.catchTags({
                  ThreadObjectError: (error) => {
                    failures += 1;
                    if (failures > 20) return Stream.fail(error);
                    return Stream.concat(
                      Stream.fromEffect(
                        Effect.sleep(Math.min(250 * 2 ** (failures - 1), 5_000)),
                      ).pipe(Stream.drain),
                      Stream.suspend(attempt),
                    );
                  },
                }),
              );
          return attempt();
        }),
      ),
  });
});

export const layer = Layer.effect(CloudTerminals.CloudTerminals, make);
