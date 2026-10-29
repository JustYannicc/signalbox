// @effect-diagnostics nodeBuiltinImport:off - Stream errors are observed passively through errorMonitor.
import * as NodeEvents from "node:events";

import type { NodeChildProcess } from "../childProcess/ChildProcess.ts";
import { serializeTraceArgs } from "./serialize.ts";
import type { TraceChildEventKind } from "./types.ts";

export interface TraceStreamState {
  readonly present: boolean;
  readonly eventCounts: Record<"end" | "finish" | "close" | "error", number>;
}

export type TraceChildStreams = Record<"stdin" | "stdout" | "stderr", TraceStreamState>;

type Observe = (
  childId: string,
  kind: TraceChildEventKind,
  fields: () => Readonly<Record<string, unknown>>,
) => void;

export function createTraceStreamState(present: boolean): TraceStreamState {
  return { present, eventCounts: { end: 0, finish: 0, close: 0, error: 0 } };
}

export function observeChildStream(
  child: NodeChildProcess,
  childId: string,
  streamName: "stdin" | "stdout" | "stderr",
  state: TraceStreamState,
  observe: Observe,
): void {
  const stream = child[streamName];
  if (stream === null) return;
  stream.on("end", (...args: unknown[]) => {
    state.eventCounts.end += 1;
    observe(childId, "stream", () => ({
      stream: streamName,
      eventName: "end",
      args: serializeTraceArgs(args),
    }));
  });
  stream.on("finish", (...args: unknown[]) => {
    state.eventCounts.finish += 1;
    observe(childId, "stream", () => ({
      stream: streamName,
      eventName: "finish",
      args: serializeTraceArgs(args),
    }));
  });
  stream.on("close", (...args: unknown[]) => {
    state.eventCounts.close += 1;
    observe(childId, "stream", () => ({
      stream: streamName,
      eventName: "close",
      args: serializeTraceArgs(args),
    }));
  });
  stream.on(NodeEvents.errorMonitor, (...args: unknown[]) => {
    state.eventCounts.error += 1;
    observe(childId, "stream", () => ({
      stream: streamName,
      eventName: "error",
      args: serializeTraceArgs(args),
    }));
  });
}

export function traceStreamSnapshot(
  streams: Readonly<TraceChildStreams>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(streams).map(([name, state]) => [
      name,
      { present: state.present, eventCounts: { ...state.eventCounts } },
    ]),
  );
}
