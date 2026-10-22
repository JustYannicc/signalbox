import type { Computer } from "../../computer/Computer.ts";
import type { KernelHandle } from "../../kernel/KernelAbi.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import type { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import type { KernelSessionStdio } from "../../kernel/KernelSessionStdio.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import type { NodeEnvironmentOptions } from "../../isolate/NodeEnvironment.ts";
import type {
  NodePreparedModuleResolver,
  NodePreparedModuleResolve,
} from "../../isolate/NodeModule.ts";
import type { NodeProcessEnvironment, NodeRuntimeIdentity } from "../../isolate/NodeProcess.ts";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";

import type { LoadedHarnessRelease } from "../HarnessReleaseLoader.ts";
import type {
  ReleaseChunkOmittedEvent,
  ReleaseChunkOmittedFailure,
} from "../HarnessProcessLifetime.ts";

export interface NodeHarnessProcessInput {
  readonly loadedRelease?: LoadedHarnessRelease;
  readonly host: KernelProgramHost;
  readonly computer: Computer;
  readonly stdio: KernelSessionStdio;
  readonly identity: NodeRuntimeIdentity;
  readonly systemIdentity?: SystemIdentity;
  readonly env: NodeProcessEnvironment;
  /** The running guest's kernel handle, when it is not the facet's root process. */
  readonly processHandle?: KernelHandle<"process">;
  readonly signal?: AbortSignal;
  readonly nativeModules: Readonly<Record<string, object>>;
  readonly loadPackages: (
    bridge: NodeBridge,
    signal: AbortSignal,
  ) => Promise<NodeEnvironmentOptions["packages"]>;
  readonly loadRelease: (bridge: NodeBridge, signal: AbortSignal) => Promise<unknown>;
  readonly prepared?: NodePreparedModuleResolver;
  readonly resolvePrepared?: NodePreparedModuleResolve;
  readonly addons?: NodeEnvironmentOptions["addons"];
  readonly bun: { readonly main: string; readonly version: string; readonly revision: string };
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly reportReleaseChunkOmitted?: (
    event: ReleaseChunkOmittedEvent,
    failure: ReleaseChunkOmittedFailure,
  ) => void | Promise<void>;
}

export interface NodeHarnessProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<KernelExitStatus>;
  readonly abort: (reason?: unknown, signal?: 9 | 15) => Promise<void>;
  readonly dispose: () => Promise<void>;
}
