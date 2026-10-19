import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Computer } from "../../computer/Computer.ts";
import type { ComputerBindings } from "../../computer/OpenComputer.ts";
import type { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { FilePersistencePorts } from "../../kernel/FilePersistencePorts.ts";
import type { KernelPosixOptions, WasiStdio } from "../../kernel/KernelFileSystem.ts";
import type { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type { AdapterRuntimeFactory } from "../AdapterHarness.ts";
import type { HarnessError, HarnessOpenInput, HarnessRelease, HarnessSession } from "../Harness.ts";
import type { LoadedHarnessRelease, LoadHarnessReleaseOptions } from "../HarnessReleaseLoader.ts";

export type SeedStage = "assets" | "programs";
export type HostOpenInput = Pick<HarnessOpenInput, "session" | "checkpoint"> & {
  readonly bootAttemptId: string;
};
export interface SeedMetadata {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}
export interface ProgramSeed {
  readonly sourceIdentity: string;
  readonly files: Readonly<
    Record<string, SeedMetadata & { readonly bytes: number; readonly sha256: string }>
  >;
  readonly read: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
}
export interface ResolvedConnections {
  readonly servers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly directTools: readonly string[];
  }>;
}
export type ExecutorTarget =
  | { readonly type: "executor" }
  | { readonly type: "direct"; readonly serverId: string; readonly tools: readonly string[] };
export interface ExecutorMcpPort<G> {
  /** Executor checks this supplied grant on every call and owns upstream authentication. */
  readonly forward: (input: {
    readonly target: ExecutorTarget;
    readonly grant: G;
    readonly request: Request;
    readonly signal: AbortSignal;
  }) => Promise<Response>;
}
export interface TurnAccess<G> {
  readonly grant: G;
  readonly signal: AbortSignal;
  readonly connections: ResolvedConnections;
}
export interface NativeMcpConfiguration {
  readonly epoch: number;
  readonly servers: Readonly<Record<string, { readonly url: string }>>;
}
export interface NativeHostBinding {
  readonly factory: AdapterRuntimeFactory["Service"];
  /** Await native installation before the next prompt; lazy first queries must enforce this too. */
  readonly configureMcp: (
    config: NativeMcpConfiguration,
    signal: AbortSignal,
  ) => Effect.Effect<void, HarnessError>;
}
export interface HarnessHostFilesOptions {
  readonly identity: string;
  readonly database: FacetStorage;
  readonly nowNs: () => bigint;
  readonly wakes: KernelWakeRegistry;
  readonly persistencePorts: FilePersistencePorts;
  readonly rootMetadata: SeedMetadata;
  readonly posix: KernelPosixOptions;
  readonly assetMode: number;
  readonly cwd: string;
  readonly stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
}
export interface HarnessHostOptions<G> {
  readonly threadId: string;
  readonly files: HarnessHostFilesOptions;
  readonly release: LoadHarnessReleaseOptions;
  readonly programs: ProgramSeed;
  readonly modelTransport: HarnessOpenInput["modelTransport"];
  readonly hooks?: HarnessOpenInput["hooks"];
  readonly executor: ExecutorMcpPort<G>;
  readonly bindComputer: (input: {
    readonly threadId: string;
    readonly files: Computer["files"];
    readonly persistence: ReturnType<typeof createFacetFilePersistence>;
    readonly signal: AbortSignal;
  }) => Effect.Effect<Omit<ComputerBindings, "files">, HarnessError, Scope.Scope>;
  readonly buildRuntime: (input: {
    readonly harness: HarnessOpenInput;
    readonly loaded: LoadedHarnessRelease;
    readonly bootAttemptId: string;
    readonly mcp: { readonly origin: string; readonly fetch: (r: Request) => Promise<Response> };
    readonly signal: AbortSignal;
  }) => Effect.Effect<NativeHostBinding, HarnessError, Scope.Scope>;
}
export interface HarnessHostSession<G> extends Omit<HarnessSession, "turn"> {
  readonly turn: (input: {
    readonly turn: RunnerTurn;
    readonly access: TurnAccess<G>;
  }) => Effect.Effect<void, HarnessError>;
}
export interface HarnessSessionHost<G> {
  readonly threadId: string;
  readonly release: HarnessRelease;
  readonly seed: (stage: SeedStage) => Effect.Effect<void, HarnessError>;
  readonly open: (input: HostOpenInput) => Effect.Effect<HarnessHostSession<G>, HarnessError>;
  readonly dispose: Effect.Effect<void, HarnessError>;
}
