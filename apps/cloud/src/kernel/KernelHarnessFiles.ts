import type { FacetStorage } from "./FacetSqliteStorage.ts";
import type { FilePersistencePorts } from "./FilePersistencePorts.ts";
import type { KernelPosixOptions, WasiStdio } from "./KernelFileSystem.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

export type SeedStage = "assets" | "programs";

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
