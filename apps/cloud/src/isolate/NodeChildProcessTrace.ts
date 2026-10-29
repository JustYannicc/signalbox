export { createNodeChildProcessTrace } from "./node/childProcessTrace/recorder.ts";
export { serializeNodeTraceValue } from "./node/childProcessTrace/serialize.ts";
export type {
  NodeChildProcessTraceChildSnapshot,
  NodeChildProcessTraceEvent,
  NodeChildProcessTraceLocator,
  NodeChildProcessTraceNormalizedSpawn,
  NodeChildProcessTraceOptions,
  NodeChildProcessTraceOutputMetadata,
  NodeChildProcessTraceRecorder,
  NodeChildProcessTraceSnapshot,
  NodeChildProcessTraceWriterError,
  TraceChildEventKind,
  TracePresence,
  TraceTiming,
} from "./node/childProcessTrace/types.ts";
