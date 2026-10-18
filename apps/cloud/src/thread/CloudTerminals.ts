import {
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalCloseInput,
  type TerminalResizeInput,
  type TerminalClearInput,
  type TerminalRestartInput,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
  type TerminalError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Actor, ThreadNotFoundError, ThreadObjectError } from "./ThreadAccess.ts";

export type CloudTerminalError = TerminalError | ThreadNotFoundError | ThreadObjectError;

export class CloudTerminals extends Context.Service<
  CloudTerminals,
  {
    readonly open: (
      actor: Actor,
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, CloudTerminalError>;
    readonly write: (
      actor: Actor,
      input: TerminalWriteInput,
    ) => Effect.Effect<void, CloudTerminalError>;
    readonly close: (
      actor: Actor,
      input: TerminalCloseInput,
    ) => Effect.Effect<void, CloudTerminalError>;
    readonly resize: (
      actor: Actor,
      input: TerminalResizeInput,
    ) => Effect.Effect<void, CloudTerminalError>;
    readonly clear: (
      actor: Actor,
      input: TerminalClearInput,
    ) => Effect.Effect<void, CloudTerminalError>;
    readonly restart: (
      actor: Actor,
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, CloudTerminalError>;
    readonly attach: (
      actor: Actor,
      input: TerminalAttachInput,
      observe: boolean,
    ) => Stream.Stream<TerminalAttachStreamEvent, CloudTerminalError>;
  }
>()("@signalbox/cloud/thread/CloudTerminals") {}
