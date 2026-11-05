import type { ClaudeCliProcessPort, ClaudeSdkReport } from "./ClaudeSdkHostProtocol.ts";
import type { ClaudeToolHookInput } from "./ClaudeToolObservation.ts";
import type { HarnessOpenInput } from "./Harness.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import type { KernelChildRegistration } from "../kernel/KernelChildDispatchPort.ts";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { Computer } from "../computer/Computer.ts";
import type { KernelCommand, KernelCommandChild } from "../kernel/KernelCommandForwarder.ts";
import type { SeedCatalog } from "../kernel/KernelSeedCatalog.ts";
import type {
  KernelFileTransferManifest,
  KernelFileTransferPort,
} from "../kernel/KernelFileTransfer.ts";

export interface ClaudeKernelCallbacks {
  model(id: string, request: Request): Promise<Response>;
  cancel(id: string, reason?: unknown): Promise<void>;
  report(report: ClaudeSdkReport): Promise<void>;
  startup(cause: unknown): Promise<void>;
  observeTool(input: ClaudeToolHookInput, toolUseId: string | undefined): Promise<void>;
  continuation(input: unknown): Promise<void>;
  output(fd: number, bytes: Uint8Array): Promise<void>;
  input(bytes: Uint8Array): Promise<void>;
}

export interface ClaudeKernelSeedSource {
  read(
    stage: "assets" | "programs",
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  releasePayload(path: string, offset: number, length: number): Promise<Uint8Array>;
  release(stage: "assets" | "programs"): Promise<void>;
}

export interface ClaudeKernelProcessConfiguration extends Pick<
  NodeHarnessProcessInput,
  "identity" | "env" | "bun" | "systemIdentity"
> {}

export interface ClaudeKernelCommand {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly control: {
    exited(): Promise<Awaited<KernelCommandChild["exited"]>>;
    signal(signal: number): ReturnType<KernelCommandChild["signal"]>;
    dispose(): Promise<void>;
  };
}

export interface ClaudeKernelInitialize {
  readonly threadId: string;
  readonly sessionKey: string;
  readonly nativeSessionId?: string;
  readonly process: ClaudeKernelProcessConfiguration;
  readonly files: Pick<
    import("./host/contracts.ts").HarnessHostFilesOptions,
    "identity" | "rootMetadata" | "posix" | "cwd" | "assetMode"
  >;
  readonly machineInventory: import("../computer/MachineProgramInventory.ts").MachineProgramInventory;
}

/** Every operation is async; native Node filesystem calls stay inside this facet. */
export interface ClaudeKernelSessionPort {
  initialize(input: ClaudeKernelInitialize): Promise<{ readonly fileIdentity: string }>;
  configure(input: {
    readonly threadId: string;
    readonly process: ClaudeKernelProcessConfiguration;
    readonly loaded: Pick<LoadedHarnessRelease, "plan">;
    readonly catalog: Pick<SeedCatalog, "id" | "stages">;
    readonly owner: ComputerProgramOwnerPort;
    readonly source: ClaudeKernelSeedSource;
    readonly callbacks: ClaudeKernelCallbacks;
  }): Promise<{
    readonly fileIdentity: string;
    readonly registrations: readonly KernelChildRegistration[];
  }>;
  seed(stage: "assets" | "programs", operationId?: string): Promise<void>;
  claim(attemptId: string, inputHash: string, operationId?: string): Promise<void>;
  prepare(operationId?: string): Promise<void>;
  materialize(manifest: KernelFileTransferManifest, source: KernelFileTransferPort): Promise<void>;
  capture(paths: readonly string[]): Promise<{
    readonly manifest: KernelFileTransferManifest;
    readonly source: KernelFileTransferPort;
  }>;
  open(
    input: Omit<HarnessOpenInput, "computer" | "modelTransport" | "hooks" | "loadedRelease">,
  ): Promise<ClaudeCliProcessPort>;
  exec(id: string, command: KernelCommand, localOnly: boolean): Promise<ClaudeKernelCommand>;
  cancel(id: string, reason?: unknown): Promise<void>;
  save(operationId?: string): ReturnType<Computer["save"]>;
  port(
    port: number,
    operationId?: string,
  ): Promise<import("./ClaudeKernelNetworkPort.ts").ClaudeKernelNetworkPort>;
  kernelIdentity(): Promise<{ readonly kernelNonce: string; readonly fileIdentity: string }>;
  close(): Promise<void>;
}
