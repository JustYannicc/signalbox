import { NonNegativeInt, TerminalEvent, ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./threadWire.ts";

export const TerminalDelivery = Schema.Struct({
  threadId: ThreadId,
  contextId: SignalboxContextId,
  sequence: NonNegativeInt,
  updatedAt: Schema.String,
  events: Schema.Array(TerminalEvent),
});
export type TerminalDelivery = typeof TerminalDelivery.Type;

export const wire = {
  delivery: jsonCodec(TerminalDelivery),
};
