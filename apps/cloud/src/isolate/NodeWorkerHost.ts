/** Bump when the observable worker transport changes. */
export const NODE_WORKER_HOST_VERSION = "node-worker-host-v1";

/** The codec keeps object identity and port/buffer references inside this packet. */
export interface NodeWorkerClonePacket {
  readonly data: string;
  readonly buffers: readonly Uint8Array[];
}

export interface NodeWorkerGraph {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
}

export interface NodeWorkerStart {
  /** A lifetime label. The host derives immutable code identity from the graph. */
  readonly id: string;
  readonly graph: NodeWorkerGraph;
  readonly workerData: NodeWorkerClonePacket;
}

export interface NodeWorkerMessage {
  /** Zero addresses the worker global; positive ids address transferred ports. */
  readonly port: number;
  readonly packet: NodeWorkerClonePacket;
}

export interface NodeWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type NodeWorkerEvent =
  | { readonly type: "online" }
  | { readonly type: "message"; readonly message: NodeWorkerMessage }
  | { readonly type: "error"; readonly error: NodeWorkerError }
  | { readonly type: "closed"; readonly exitCode: number };

/** A host-owned callback capability, scoped to one worker lifetime. */
export interface NodeWorkerHostEvents {
  emit(event: NodeWorkerEvent): Promise<void>;
}

export interface NodeWorkerSession {
  /** Delivery order is preserved. Acknowledgement does not await the guest's reply. */
  deliver(message: NodeWorkerMessage): Promise<void>;
  /** Resolves only after child callbacks, ports and owned tasks have stopped. */
  stop(): Promise<void>;
  [Symbol.dispose](): void;
}

/**
 * Opens a distinct child realm and returns its retained per-lifetime capability.
 * Reusing a WorkerLoader code id never establishes session continuity. The host
 * retains its shared child permit until stop acknowledges actual cleanup.
 */
export interface NodeWorkerHost {
  open(input: NodeWorkerStart, events: NodeWorkerHostEvents): Promise<NodeWorkerSession>;
}
