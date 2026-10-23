import type { NodeWorkerMessage, NodeWorkerPortAddress } from "./protocol.ts";
import type { NodeWorkerPortContext } from "./portRuntime.ts";

/** The supervisor resolves this identity in its own verified module store. */
export interface NodeWorkerGraphReference {
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly sourceIdentity: string;
}

export type NodeWorkerEntry =
  | { readonly kind: "file"; readonly url: string }
  | { readonly kind: "eval"; readonly source: string };

export interface NodeWorkerResourceLimits {
  readonly maxYoungGenerationSizeMb?: number;
  readonly maxOldGenerationSizeMb?: number;
  readonly codeRangeSizeMb?: number;
  readonly stackSizeMb?: number;
}

export interface NodeWorkerStartRequest {
  readonly graph: NodeWorkerGraphReference;
  readonly entry: NodeWorkerEntry;
  readonly owner: string;
  readonly threadId: number;
  /** Contains workerData and the transferred child end of the parent channel. */
  readonly input: NodeWorkerMessage;
  readonly environmentData: NodeWorkerMessage;
  readonly env: Readonly<Record<string, string>>;
  /** Worker options.argv, appended after the executable and entry by the child host. */
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly name: string;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  readonly resourceLimits: NodeWorkerResourceLimits;
}

export interface NodeWorkerExit {
  readonly code: number;
  /** Actual guest settlement and callback closure, never an RPC disconnect alone. */
  readonly stopped: true;
}

export interface NodeWorkerRunEvents {
  online(): Promise<void>;
  output(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void>;
  error(error: Error): Promise<void>;
}

export interface NodeWorkerRun {
  wait(): Promise<NodeWorkerExit>;
  terminate(): Promise<NodeWorkerExit>;
  writeStdin(bytes: Uint8Array | null): Promise<void>;
}

export interface NodeWorkerSupervisor {
  start(request: NodeWorkerStartRequest, events: NodeWorkerRunEvents): Promise<NodeWorkerRun>;
}

export interface NodeWorkerModuleLoader {
  readonly reference: NodeWorkerGraphReference;
  /** Resolve a guest filename only. Evaluation belongs to the child's loadWorkerEntry adapter. */
  resolve(filename: string | URL): string;
}

export interface NodeWorkerThreadContext {
  readonly ports: NodeWorkerPortContext;
  readonly threadId: number;
  readonly isMainThread: boolean;
  readonly parentPort?: NodeWorkerPortAddress;
  readonly workerData?: unknown;
  readonly environmentData?: ReadonlyMap<unknown, unknown>;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly resourceLimits?: NodeWorkerResourceLimits;
  /** Reserved by the process host before the synchronous Worker constructor returns. */
  allocateThreadId(): number;
  output(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void>;
}
