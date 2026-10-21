import type * as Brand from "effect/Brand";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { FileCommitReceipt } from "../kernel/FilePersistencePorts.ts";
import type { ChildWorkerRequester } from "./ChildWorkerCapacity.ts";

export type DriveRef = SignalboxDriveId;
export type RecipeHash = string & Brand.Brand<"RecipeHash">;

export interface BaseLease {
  readonly id: string;
  readonly sourceRef: string;
  /** Deadline to begin a fork. It does not bound a source held by a lease. */
  readonly expiresAt: number;
  /** Provider assertion that the source survives restart until idempotent release. Optional only in legacy rows. */
  readonly retention?: "until-release";
}

/** Return Some only when the source is durable through release; otherwise return None. */
export interface Bases {
  readonly acquire: (
    drive: DriveRef,
    recipeHash: RecipeHash,
  ) => Effect.Effect<Option.Option<BaseLease>>;
  /** Idempotent by lease id, including leases already expired or released. */
  readonly release: (lease: BaseLease) => Effect.Effect<void>;
}

/** Shared by command hooks, harness child processes and the exec server. */
export interface ComputerExecPort {
  /** Pass undefined only for a root with no slot-holding ancestor. */
  readonly exec: (
    command: KernelCommand,
    signal: AbortSignal,
    requester: ChildWorkerRequester | undefined,
  ) => Promise<KernelCommandChild>;
}

export interface ComputerPort {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** One instance belongs to one thread. The session facet retains ownership of files. */
export interface Computer extends ComputerExecPort {
  readonly threadId: string;
  readonly files: KernelFileSystem;
  readonly port: (port: number, signal: AbortSignal) => Promise<ComputerPort>;
  readonly save: (signal: AbortSignal) => Promise<FileCommitReceipt>;
}

export interface ComputerOpenPort {
  readonly open: (threadId: string, signal: AbortSignal) => Promise<Computer>;
}

/** Adapt the Computer command entry point without another execution or policy path. */
export function computerCommandForwarder(
  computer: ComputerExecPort,
  requester: ChildWorkerRequester | undefined,
): KernelCommandForwarder {
  return { spawn: (command, signal) => computer.exec(command, signal, requester) };
}
