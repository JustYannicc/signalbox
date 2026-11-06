import type * as NodeEvents from "node:events";
import type { NodeChildProcess } from "./node/childProcess/ChildProcess.ts";

/** Node compatibility owns the EventEmitter; the process owner supplies admission and lifetime. */
export type NodeChildProcessHandle = Omit<
  Pick<NodeChildProcess, keyof NodeChildProcess>,
  keyof NodeEvents.EventEmitter
> &
  NodeEvents.EventEmitter;
