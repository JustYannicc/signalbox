import { TerminalError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { jsonLine } from "../threadWire.ts";
import { ThreadNotFoundError } from "../ThreadEngine.ts";
import * as ThreadTerminals from "./ThreadTerminals.ts";
import { terminalWire, type TerminalObjectApi, type TerminalReply } from "./terminalDirectory.ts";

const isTerminalError = Schema.is(TerminalError);
const isNotFound = Schema.is(ThreadNotFoundError);
const encodeLine = jsonLine(terminalWire.event);

export const makeTerminalObjectApi = (
  run: <A, E>(effect: Effect.Effect<A, E, ThreadTerminals.ThreadTerminals>) => Promise<A>,
  afterChange: () => Promise<void>,
): TerminalObjectApi => {
  const reply = <A, E>(
    effect: Effect.Effect<A, E, ThreadTerminals.ThreadTerminals>,
  ): Promise<TerminalReply<A>> =>
    run(
      effect.pipe(
        Effect.map((value): TerminalReply<A> => ({ _tag: "ok", value })),
        Effect.catch((error): Effect.Effect<TerminalReply<A>> => {
          if (isNotFound(error)) return Effect.succeed({ _tag: "not_found" } as const);
          if (isTerminalError(error))
            return Effect.succeed({
              _tag: "terminal_error",
              error: terminalWire.error.encode(error),
            } as const);
          return Effect.die(error);
        }),
      ),
    );
  return {
    terminalOpen: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          Effect.map(
            service.open(actor, terminalWire.open.decode(input)),
            terminalWire.snapshot.encode,
          ),
        ),
      );
      await afterChange();
      return result;
    },
    terminalWrite: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          service.write(actor, terminalWire.write.decode(input)),
        ),
      );
      await afterChange();
      return result;
    },
    terminalClose: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          service.close(actor, terminalWire.close.decode(input)),
        ),
      );
      await afterChange();
      return result;
    },
    terminalResize: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          service.resize(actor, terminalWire.resize.decode(input)),
        ),
      );
      await afterChange();
      return result;
    },
    terminalClear: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          service.clear(actor, terminalWire.clear.decode(input)),
        ),
      );
      await afterChange();
      return result;
    },
    terminalRestart: async (actor, input) => {
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          service
            .restart(actor, terminalWire.restart.decode(input))
            .pipe(Effect.map(terminalWire.snapshot.encode)),
        ),
      );
      await afterChange();
      return result;
    },
    terminalAttach: async (actor, input, observe) => {
      const decoded = terminalWire.attach.decode(input);
      const result = await reply(
        ThreadTerminals.ThreadTerminals.use((service) =>
          (observe ? service.observe(actor, decoded) : service.attach(actor, decoded)).pipe(
            Effect.map((stream) => stream.pipe(Stream.map(encodeLine), Stream.toReadableStream())),
          ),
        ),
      );
      if (!observe) await afterChange();
      return result;
    },
  };
};
