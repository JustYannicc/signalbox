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

/**
 * What changed after the base revision: inodes, and names in directories (by the directory's
 * inode). `inodes` is null when Computer can't list it, as while a machine command runs.
 */
export interface ClaudeCliChanges {
  readonly revision: number;
  readonly inodes: readonly bigint[] | null;
  readonly names: readonly { readonly parent: bigint; readonly name: string }[];
}

/** One path read at call time. `names` lists a readable directory. */
export type ClaudeCliLookup =
  | { readonly path: string; readonly entry: CliFileMetadata; readonly names?: readonly string[] }
  | { readonly path: string; readonly missing: true }
  | { readonly path: string; readonly denied: true };

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
  /** Pages one index snapshot. Its revision is where the read started; later changes are in `changes`. */
  metadata(cursor: number, revision?: number): Promise<ClaudeCliMetadataPage>;
  changes(since: number): Promise<ClaudeCliChanges>;
  lookup(paths: readonly string[]): Promise<readonly ClaudeCliLookup[]>;
  prefetch(path: string, offset: number, length: number): Promise<Uint8Array>;
  /**
   * SHA-256 hex of each regular file's current bytes, or null when it is not one or its size is
   * no longer the one the CLI's index read.
   */
  digest(
    files: readonly { readonly path: string; readonly size: number }[],
    /** A revision Computer issued; its feed can prove upper files unchanged without a read. */
    since?: number,
  ): Promise<readonly (string | null)[]>;
  leaseProcesses(
    count: number,
  ): Promise<readonly { readonly pid: number; readonly handle: KernelHandle<"process"> }[]>;
  leaseDescriptors(count: number): Promise<readonly number[]>;
  reserveDescriptor(fd: number): Promise<void>;
  signalProcess(selector: number, signal: number): Promise<void>;
  /** Returns the filesystem revision after the CLI's committed state. */
  processState(cwd: string, umask: number | undefined): Promise<number>;
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
