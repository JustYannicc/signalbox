import { addressInUse } from "./errors.ts";

export type LoopbackProtocol = "http" | "https" | "net";

export interface LoopbackListener {
  readonly owner: symbol;
  readonly port: number;
  readonly protocol: LoopbackProtocol;
  readonly server: object;
  readonly address: string;
}

const EPHEMERAL_PORT_MIN = 49_152;
const EPHEMERAL_PORT_MAX = 65_535;

/** One host's local port namespace. HTTP and raw TCP listeners cannot overlap. */
export class LoopbackRegistry {
  readonly #listeners = new Map<number, LoopbackListener>();
  #nextEphemeral = EPHEMERAL_PORT_MIN;

  reserve(
    requestedPort: number,
    protocol: LoopbackProtocol,
    server: object,
    address: string,
    excluded: ReadonlySet<number> = new Set(),
  ): LoopbackListener {
    const port = requestedPort === 0 ? this.#nextAvailable(excluded) : requestedPort;
    if (port === 0 || this.#listeners.has(port) || excluded.has(port)) {
      throw addressInUse(address, port || requestedPort);
    }
    const listener = Object.freeze({
      owner: Symbol("loopback listener"),
      port,
      protocol,
      server,
      address,
    });
    this.#listeners.set(port, listener);
    return listener;
  }

  release(listener: LoopbackListener): boolean {
    if (this.#listeners.get(listener.port) !== listener) return false;
    this.#listeners.delete(listener.port);
    return true;
  }

  get(port: number): LoopbackListener | undefined {
    return this.#listeners.get(port);
  }

  getForProtocol(port: number, protocol: LoopbackProtocol): LoopbackListener | undefined {
    const listener = this.#listeners.get(port);
    return listener?.protocol === protocol ? listener : undefined;
  }

  #nextAvailable(excluded: ReadonlySet<number>): number {
    for (let count = 0; count <= EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN; count += 1) {
      const port = this.#nextEphemeral;
      this.#nextEphemeral = port === EPHEMERAL_PORT_MAX ? EPHEMERAL_PORT_MIN : port + 1;
      if (!this.#listeners.has(port) && !excluded.has(port)) return port;
    }
    return 0;
  }
}
