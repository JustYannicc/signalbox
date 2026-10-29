import type { KernelFileSystem } from "../../../../kernel/KernelFileSystem.ts";
import type { NormalizedSpawn } from "../../childProcess/arguments.ts";
import type { NodeChildProcessTraceOutputMetadata } from "../types.ts";

export type Descriptor = ReturnType<KernelFileSystem["descriptors"]["get"]>;
export type MountedStorage = NonNullable<Descriptor["mount"]>;
export type CaptureStorage = MountedStorage["storage"];

export interface OutputPath {
  readonly fd: number;
  readonly pathComponents: readonly string[] | null;
}

export interface OutputAlias {
  readonly stream: "stdout" | "stderr";
  readonly fd: number;
  readonly descriptor: Descriptor;
  readonly fstat: { readonly size: bigint; readonly mtimeNs: bigint };
}

export interface OutputCapture {
  outputId: string;
  readonly streams: ("stdout" | "stderr")[];
  readonly mount: MountedStorage;
  readonly inode: bigint;
  readonly storage: CaptureStorage;
  readonly paths: OutputPath[];
  readonly initialStats: { readonly fd: number; readonly size: bigint; readonly mtimeNs: bigint }[];
}

export interface OutputResult extends Readonly<Record<string, unknown>> {
  readonly outputId?: string;
  readonly streams?: readonly string[];
  readonly status: string;
}

export interface OutputPreparationOptions {
  readonly processKey: string;
  readonly childId: string;
  readonly spawn: NormalizedSpawn;
  readonly files: () => KernelFileSystem;
  readonly emit: (fields: Readonly<Record<string, unknown>>) => void;
  readonly remember: (result: OutputResult) => void;
  readonly track: (job: Promise<unknown>) => void;
  readonly onFailure: (
    operation: "write-output-chunk" | "finish-output" | "capture-output",
    outputId: string,
    error: unknown,
  ) => void;
  readonly writeOutputChunk: (outputId: string, bytes: Uint8Array) => void | Promise<void>;
  readonly finishOutput: (
    metadata: NodeChildProcessTraceOutputMetadata,
  ) => string | { readonly locator: string } | Promise<string | { readonly locator: string }>;
}

export interface PreparedOutputCapture {
  readonly captureAfterClose: () => Promise<readonly OutputResult[]>;
  readonly releaseWithoutCapture: (reason: string) => Promise<readonly OutputResult[]>;
}
