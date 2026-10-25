import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalCloseInput,
  TerminalResizeInput,
  TerminalClearInput,
  TerminalRestartInput,
  TerminalError,
  TerminalOpenInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { type Actor, ThreadNotFoundError, ThreadObjectError } from "../ThreadAccess.ts";
import { jsonCodec } from "../threadWire.ts";

export const terminalWire = {
  open: jsonCodec(TerminalOpenInput),
  attach: jsonCodec(TerminalAttachInput),
  write: jsonCodec(TerminalWriteInput),
  close: jsonCodec(TerminalCloseInput),
  resize: jsonCodec(TerminalResizeInput),
  clear: jsonCodec(TerminalClearInput),
  restart: jsonCodec(TerminalRestartInput),
  snapshot: jsonCodec(TerminalSessionSnapshot),
  event: jsonCodec(TerminalAttachStreamEvent),
  error: jsonCodec(TerminalError),
};

export type TerminalReply<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "terminal_error"; readonly error: unknown };

export interface TerminalObjectApi {
  readonly terminalOpen: (actor: Actor, input: unknown) => Promise<TerminalReply<unknown>>;
  readonly terminalWrite: (actor: Actor, input: unknown) => Promise<TerminalReply<void>>;
  readonly terminalClose: (actor: Actor, input: unknown) => Promise<TerminalReply<void>>;
  readonly terminalResize: (actor: Actor, input: unknown) => Promise<TerminalReply<void>>;
  readonly terminalClear: (actor: Actor, input: unknown) => Promise<TerminalReply<void>>;
  readonly terminalRestart: (actor: Actor, input: unknown) => Promise<TerminalReply<unknown>>;
  readonly terminalAttach: (
    actor: Actor,
    input: unknown,
    observe: boolean,
  ) => Promise<TerminalReply<ReadableStream<Uint8Array>>>;
}

type Failure = TerminalError | ThreadNotFoundError | ThreadObjectError;

export interface TerminalHandle {
  readonly terminalOpen: (
    actor: Actor,
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, Failure>;
  readonly terminalWrite: (actor: Actor, input: TerminalWriteInput) => Effect.Effect<void, Failure>;
  readonly terminalClose: (actor: Actor, input: TerminalCloseInput) => Effect.Effect<void, Failure>;
  readonly terminalResize: (
    actor: Actor,
    input: TerminalResizeInput,
  ) => Effect.Effect<void, Failure>;
  readonly terminalClear: (actor: Actor, input: TerminalClearInput) => Effect.Effect<void, Failure>;
  readonly terminalRestart: (
    actor: Actor,
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, Failure>;
  readonly terminalAttach: (
    actor: Actor,
    input: TerminalAttachInput,
    observe: boolean,
  ) => Stream.Stream<TerminalAttachStreamEvent, Failure>;
}

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ThreadObjectError({ operation, cause }) });

const decode = <A>(operation: string, read: () => A) =>
  Effect.try({ try: read, catch: (cause) => new ThreadObjectError({ operation, cause }) });

const fromReply = <A>(reply: TerminalReply<A>): Effect.Effect<A, Failure> => {
  switch (reply._tag) {
    case "ok":
      return Effect.succeed(reply.value);
    case "not_found":
      return Effect.fail(new ThreadNotFoundError());
    case "terminal_error":
      return decode("terminal.error", () => terminalWire.error.decode(reply.error)).pipe(
        Effect.flatMap(Effect.fail),
      );
  }
};

export const terminalHandleFor = (api: TerminalObjectApi): TerminalHandle => ({
  terminalOpen: (actor, input) =>
    call("terminal.open", () => api.terminalOpen(actor, terminalWire.open.encode(input))).pipe(
      Effect.flatMap(fromReply),
      Effect.flatMap((value) => decode("terminal.open", () => terminalWire.snapshot.decode(value))),
    ),
  terminalWrite: (actor, input) =>
    call("terminal.write", () => api.terminalWrite(actor, terminalWire.write.encode(input))).pipe(
      Effect.flatMap(fromReply),
    ),
  terminalClose: (actor, input) =>
    call("terminal.close", () => api.terminalClose(actor, terminalWire.close.encode(input))).pipe(
      Effect.flatMap(fromReply),
    ),
  terminalResize: (actor, input) =>
    call("terminal.resize", () =>
      api.terminalResize(actor, terminalWire.resize.encode(input)),
    ).pipe(Effect.flatMap(fromReply)),
  terminalClear: (actor, input) =>
    call("terminal.clear", () => api.terminalClear(actor, terminalWire.clear.encode(input))).pipe(
      Effect.flatMap(fromReply),
    ),
  terminalRestart: (actor, input) =>
    call("terminal.restart", () =>
      api.terminalRestart(actor, terminalWire.restart.encode(input)),
    ).pipe(
      Effect.flatMap(fromReply),
      Effect.flatMap((value) =>
        decode("terminal.restart", () => terminalWire.snapshot.decode(value)),
      ),
    ),
  terminalAttach: (actor, input, observe) =>
    Stream.unwrap(
      call("terminal.attach", () =>
        api.terminalAttach(actor, terminalWire.attach.encode(input), observe),
      ).pipe(
        Effect.flatMap(fromReply),
        Effect.map((body) =>
          Stream.fromReadableStream({
            evaluate: () => body,
            onError: (cause) => new ThreadObjectError({ operation: "terminal.attach", cause }),
          }).pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect((line) =>
              decode("terminal.attach", () => terminalWire.event.decode(JSON.parse(line))),
            ),
          ),
        ),
      ),
    ),
});
