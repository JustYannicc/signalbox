import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  TerminalOperationError,
  TerminalSessionLookupError,
  type TerminalAttachInput,
  type TerminalCloseInput,
  type TerminalResizeInput,
  type TerminalClearInput,
  type TerminalRestartInput,
  type TerminalOpenInput,
  type TerminalWriteInput,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Actor } from "../thread/ThreadActor.ts";
import type { ThreadNotFoundError } from "../thread/ThreadObjectError.ts";
import * as CloudTerminals from "../thread/CloudTerminals.ts";
import * as UserTerminals from "./UserTerminals.ts";

export const TERMINAL_METHODS = [
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalClose,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalRestart,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
] as const;

export const TERMINAL_SCOPES = {
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
} as const;

export const makeTerminalHandlers = Effect.fn("makeTerminalHandlers")(function* (
  actorNow: Effect.Effect<Actor>,
  lostSight: (threadId: ThreadId) => Effect.Effect<never, ThreadNotFoundError>,
) {
  const terminals = yield* CloudTerminals.CloudTerminals;
  const userTerminals = yield* UserTerminals.UserTerminals;
  const mapError =
    (
      operation: string,
      input: { readonly threadId: string; readonly terminalId?: string | undefined },
    ) =>
    (error: Effect.Error<ReturnType<CloudTerminals.CloudTerminals["Service"]["open"]>>) => {
      switch (error._tag) {
        case "ThreadNotFoundError":
          return new TerminalSessionLookupError({
            threadId: input.threadId,
            terminalId: input.terminalId ?? "",
          });
        case "ThreadObjectError":
          return new TerminalOperationError({ operation, reason: "unavailable" });
        default:
          return error;
      }
    };
  return {
    [WS_METHODS.subscribeTerminalEvents]: () => userTerminals.events.pipe(Stream.orDie),
    [WS_METHODS.subscribeTerminalMetadata]: () => userTerminals.metadata.pipe(Stream.orDie),
    [WS_METHODS.terminalOpen]: (input: TerminalOpenInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.open(actor, input)).pipe(
        Effect.mapError(mapError("open", input)),
      ),
    [WS_METHODS.terminalWrite]: (input: TerminalWriteInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.write(actor, input)).pipe(
        Effect.mapError(mapError("write", input)),
      ),
    [WS_METHODS.terminalClose]: (input: TerminalCloseInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.close(actor, input)).pipe(
        Effect.mapError(mapError("close", input)),
      ),
    [WS_METHODS.terminalResize]: (input: TerminalResizeInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.resize(actor, input)).pipe(
        Effect.mapError(mapError("resize", input)),
      ),
    [WS_METHODS.terminalClear]: (input: TerminalClearInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.clear(actor, input)).pipe(
        Effect.mapError(mapError("clear", input)),
      ),
    [WS_METHODS.terminalRestart]: (input: TerminalRestartInput) =>
      Effect.flatMap(actorNow, (actor) => terminals.restart(actor, input)).pipe(
        Effect.mapError(mapError("restart", input)),
      ),
    [WS_METHODS.terminalAttach]: (input: TerminalAttachInput) =>
      Stream.unwrap(Effect.map(actorNow, (actor) => terminals.attach(actor, input, false))).pipe(
        Stream.interruptWhen(lostSight(ThreadId.make(input.threadId))),
        Stream.mapError(mapError("attach", input)),
      ),
    [WS_METHODS.terminalObserve]: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) =>
      Stream.unwrap(Effect.map(actorNow, (actor) => terminals.attach(actor, input, true))).pipe(
        Stream.interruptWhen(lostSight(ThreadId.make(input.threadId))),
        Stream.mapError(mapError("observe", input)),
      ),
  };
});
