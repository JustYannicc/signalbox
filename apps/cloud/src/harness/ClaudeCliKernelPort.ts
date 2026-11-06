import type { KernelSyscallPort } from "../kernel/KernelSyscallPort.ts";
import type { KernelStat, KernelPosixOptions } from "../kernel/KernelFileSystem.ts";
import type {
  ClaudeKernelCallbacks,
  ClaudeKernelProcessConfiguration,
} from "./ClaudeKernelBindings.ts";
import type { ClaudeSdkFsReply, ClaudeCliProcessPort } from "./ClaudeSdkHostProtocol.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessOpenInput } from "./Harness.ts";
import type { NodeChildProcessSpawn } from "../isolate/NodeChildProcess.ts";
import type { KernelHandle } from "../kernel/KernelAbi.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { CliFileWorkingSetOptions, CliFileMetadata } from "./CliFileWorkingSet.ts";

export interface ClaudeCliMetadataPage {
  readonly revision: number;
  readonly entries: readonly CliFileMetadata[];
  readonly next: number | null;
}

export interface ClaudeCliChild {
  readonly pid: number;
  readonly handle: KernelHandle<"process">;
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
  readonly control: {
    exited(): Promise<KernelCommandExit>;
    signal(signal: number): Promise<boolean>;
    dispose(): Promise<void>;
  };
}

/** All mutable kernel state stays behind this capability in Computer. */
export interface ClaudeCliKernelPort extends KernelSyscallPort {
  cancel(id: string, reason?: unknown): Promise<void>;
  metadata(cursor: number, revision?: number): Promise<ClaudeCliMetadataPage>;
  prefetch(path: string, offset: number, length: number, revision: number): Promise<Uint8Array>;
  leaseProcesses(
    count: number,
  ): Promise<readonly { readonly pid: number; readonly handle: KernelHandle<"process"> }[]>;
  leaseDescriptors(count: number): Promise<readonly number[]>;
  signalProcess(selector: number, signal: number): Promise<void>;
  processState(cwd: string, umask: number | undefined): Promise<void>;
  sdkFiles(id: string, operation: string, args: readonly unknown[]): Promise<ClaudeSdkFsReply>;
  spawn(
    id: string,
    lease: KernelHandle<"process">,
    input: Omit<NodeChildProcessSpawn, "signal">,
  ): Promise<ClaudeCliChild>;
  finish(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ClaudeCliInitialization {
  readonly threadId: string;
  readonly nativeSessionId?: string;
  readonly process: ClaudeKernelProcessConfiguration;
  readonly systemIdentity: import("@t3tools/contracts/systemIdentity").SystemIdentity;
  readonly loaded: Pick<LoadedHarnessRelease, "plan">;
  readonly source: import("./ClaudeKernelBindings.ts").ClaudeKernelSeedSource;
  readonly cwd: string;
  readonly rootDescriptor: number;
  readonly posix: KernelPosixOptions | undefined;
  readonly workingSet: CliFileWorkingSetOptions & { readonly paths: readonly string[] };
  readonly kernel: ClaudeCliKernelPort;
  readonly callbacks: ClaudeKernelCallbacks;
  readonly io: {
    readonly stdin: ReadableStream<Uint8Array>;
    readonly stdout: WritableStream<Uint8Array>;
    readonly stderr: WritableStream<Uint8Array>;
    readonly sdkStdin: WritableStream<Uint8Array>;
    readonly sdkStdout: ReadableStream<Uint8Array>;
    readonly sdkStderr: ReadableStream<Uint8Array>;
  };
}

export interface ClaudeCliHost {
  open(
    configuration: ClaudeCliInitialization,
    input: Omit<HarnessOpenInput, "computer" | "modelTransport" | "hooks" | "loadedRelease">,
  ): Promise<ClaudeCliProcessPort>;
}

export type ClaudeCliDescriptorReadView = {
  readonly path: string;
  readonly flags: number;
  offset: bigint;
  readonly stat: KernelStat;
};
