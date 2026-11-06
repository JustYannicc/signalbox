import type { ClaudeCliProcessPort } from "./ClaudeSdkHostProtocol.ts";
import type { HarnessOpenInput } from "./Harness.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { KernelChildRegistration } from "../kernel/KernelChildDispatchPort.ts";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { Computer } from "../computer/Computer.ts";
import type { KernelCommand, KernelCommandChild } from "../kernel/KernelCommandForwarder.ts";
import type { SeedCatalog } from "../kernel/KernelSeedCatalog.ts";
import type { ClaudeTranscriptCapture } from "./ClaudeTranscriptPort.ts";
import type {
  KernelFileTransferManifest,
  KernelFileTransferPort,
} from "../kernel/KernelFileTransfer.ts";

export type {
  ClaudeKernelCallbacks,
  ClaudeKernelSeedSource,
  ClaudeKernelProcessConfiguration,
} from "./ClaudeKernelBindings.ts";
import type {
  ClaudeKernelCallbacks,
  ClaudeKernelSeedSource,
  ClaudeKernelProcessConfiguration,
} from "./ClaudeKernelBindings.ts";

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

/** Computer owns the canonical kernel. The separate CLI facet receives only capabilities and read data. */
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
    readonly cli: import("./ClaudeCliKernelPort.ts").ClaudeCliHost;
    readonly workingSet: import("./CliFileWorkingSet.ts").CliFileWorkingSetOptions & {
      readonly paths: readonly string[];
    };
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
  captureTranscripts(
    nativeId: string,
    configurationDirectory: string,
    operationId?: string,
  ): Promise<ClaudeTranscriptCapture>;
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
