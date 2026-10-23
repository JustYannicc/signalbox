export interface NodeWorkerPortAddress {
  readonly id: string;
  readonly lease: string;
}

export interface NodeWorkerPortTransfer extends NodeWorkerPortAddress {
  readonly previousLease: string;
}

export interface NodeWorkerMessage {
  readonly value: unknown;
  readonly ports: readonly {
    readonly marker: object;
    readonly handle: NodeWorkerPortTransfer;
  }[];
}

export type NodeWorkerPortEvent =
  | {
      readonly type: "message";
      readonly port: NodeWorkerPortAddress;
      readonly message: NodeWorkerMessage;
    }
  | { readonly type: "close"; readonly port: NodeWorkerPortAddress };

export interface NodeWorkerPortReceiver {
  /** A stale incarnation rejects delivery so the broker can keep it for the new owner. */
  receive(event: NodeWorkerPortEvent): Promise<boolean>;
}

/** Each connection is bound to a process lease by the supervisor. */
export interface NodeWorkerPortConnection {
  open(first: NodeWorkerPortAddress, second: NodeWorkerPortAddress): Promise<void>;
  post(port: NodeWorkerPortAddress, message: NodeWorkerMessage): Promise<void>;
  start(port: NodeWorkerPortAddress): Promise<void>;
  close(port: NodeWorkerPortAddress): Promise<void>;
}
