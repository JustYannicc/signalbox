import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import type { createNodeProcessWithIdentity } from "../../isolate/NodeProcessPersonality.ts";
import type { createNodeConsole } from "../../isolate/NodeConsole.ts";
import type { NodeChildProcessObserver } from "../../isolate/NodeChildProcess.ts";
import type { createBunShim } from "../../isolate/BunShim.ts";
import type { createNodeRuntimeCompatibility } from "../../isolate/NodeRuntimeCompatibility.ts";
import type { NodeProcessStreams } from "../../isolate/NodeProcess.ts";
import type { KernelCpuProcessExecution } from "../../kernel/KernelCpuExecution.ts";
import type { createHarnessEnvironment } from "./environment.ts";
import type { NodeHarnessBaseInput } from "./types.ts";

export interface NodeHarnessRuntime {
  readonly process: ReturnType<typeof createNodeProcessWithIdentity>;
  readonly streams: NodeProcessStreams;
  readonly modules: Record<string, object>;
  readonly bun: ReturnType<typeof createBunShim>["bun"];
  readonly console: ReturnType<typeof createNodeConsole>;
  readonly environment: ReturnType<typeof createHarnessEnvironment>;
  readonly cpu?: Pick<KernelCpuProcessExecution, "enterUser" | "run"> | undefined;
  readonly missingBunMembers: Set<string>;
  readonly drainDns: () => Promise<void>;
  readonly drainHttp: () => Promise<void>;
  readonly compatibility: ReturnType<typeof createNodeRuntimeCompatibility>;
}

export type NodeHarnessRuntimeFactory = (
  input: NodeHarnessBaseInput,
  signals: {
    readonly lifetime: AbortSignal;
    readonly stdin: AbortSignal;
    readonly output: AbortSignal;
  },
  onChild: NodeChildProcessObserver,
  bridge: () => NodeBridge,
) => NodeHarnessRuntime;
