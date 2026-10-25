import type { ComputerExecPort } from "../computer/Computer.ts";
import type { KernelProgramHost } from "../kernel/KernelProgramHost.ts";
import {
  createNodeChildProcess,
  type NodeChildProcessContext,
  type NodeChildProcess,
} from "./NodeChildProcess.ts";
import { createComputerProcessTransport } from "./node/computerProcess/transport.ts";

/** Node child_process with synchronous kernel admission and Computer-owned execution. */
export function createNodeComputerChildProcess(
  host: KernelProgramHost,
  process: NodeChildProcessContext,
  computer: ComputerExecPort,
  onChild?: (child: NodeChildProcess) => void,
): ReturnType<typeof createNodeChildProcess> {
  if (typeof computer?.exec !== "function") {
    throw new TypeError("child_process requires a Computer exec port");
  }
  return createNodeChildProcess(
    host,
    process,
    createComputerProcessTransport(host, computer),
    onChild,
  );
}
