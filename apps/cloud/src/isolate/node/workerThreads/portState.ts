import type {
  NodeWorkerMessage,
  NodeWorkerPortAddress,
  NodeWorkerPortConnection,
} from "./protocol.ts";

export interface NodeWorkerPortRuntime {
  encode(value: unknown, transferList?: readonly unknown[]): NodeWorkerMessage;
  enqueue(operation: (connection: NodeWorkerPortConnection) => Promise<void>): void;
  referencesChanged(): void;
  retire(address: NodeWorkerPortAddress): void;
  reportFailure(error: unknown): void;
}

interface PortState {
  readonly runtime: NodeWorkerPortRuntime;
  readonly address: NodeWorkerPortAddress;
  detached: boolean;
  closed: boolean;
  closeEmitted: boolean;
  started: boolean;
  referenced: boolean;
}

const portStates = new WeakMap<object, PortState>();

export function registerPortState(
  port: object,
  runtime: NodeWorkerPortRuntime,
  address: NodeWorkerPortAddress,
): void {
  portStates.set(port, {
    runtime,
    address,
    detached: false,
    closed: false,
    closeEmitted: false,
    started: false,
    referenced: true,
  });
}

export function getPortState(port: object): PortState {
  const current = portStates.get(port);
  if (current === undefined) throw new TypeError("Illegal MessagePort receiver");
  return current;
}

export function hasPortState(value: unknown): value is object {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    portStates.has(value)
  );
}

export function dataCloneError(message: string): DOMException {
  return new DOMException(message, "DataCloneError");
}
