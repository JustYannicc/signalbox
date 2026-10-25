import { RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import {
  NodeWorkerMessagePort,
  NodeWorkerPorts,
  type NodeWorkerMessage,
} from "../NodeWorkerThreads.ts";
import { createNodeWorkerPortContext, type NodeWorkerPortOwner } from "../NodeWorkerPortsRpc.ts";

let isolateCounter = 0;

class PortClient extends RpcTarget {
  readonly #runtime: NodeWorkerPorts;
  readonly #ports = new Map<string, NodeWorkerMessagePort>();
  #sequence = 0;
  #closed = false;

  constructor(runtime: NodeWorkerPorts) {
    super();
    this.#runtime = runtime;
  }

  touch(amount: number) {
    isolateCounter += amount;
    return isolateCounter;
  }

  async pair() {
    const { port1, port2 } = this.#runtime.channel();
    const id = `${++this.#sequence}`;
    this.#ports.set(id, port1);
    await this.#runtime.drain();
    return { id, packet: this.#runtime.encode({ port: port2 }, [port2]) };
  }

  async movedPair() {
    const { port1, port2 } = this.#runtime.channel();
    await this.#runtime.drain();
    return {
      first: this.#runtime.encode({ port: port1 }, [port1]),
      second: this.#runtime.encode({ port: port2 }, [port2]),
    };
  }

  accept(packet: NodeWorkerMessage, echo: boolean) {
    const value = this.#runtime.decode(packet);
    if (value === null || typeof value !== "object") throw new Error("Expected a port envelope");
    const port: unknown = Reflect.get(value, "port");
    if (!(port instanceof NodeWorkerMessagePort)) throw new Error("Expected a transferred port");
    const id = `${++this.#sequence}`;
    this.#ports.set(id, port);
    if (echo) port.on("message", (message) => port.postMessage(message));
    return id;
  }

  async roundTrip(id: string) {
    const port = this.#ports.get(id);
    if (port === undefined) throw new Error("Unknown local port");
    const reply = Promise.withResolvers<unknown>();
    port.once("message", reply.resolve);
    const buffer = Uint8Array.from([0, 1, 127, 128, 255]).buffer;
    const bytes = new Uint8Array(buffer);
    const graph: Record<string, unknown> = { bytes, alias: bytes };
    graph.self = graph;
    graph.map = new Map([[graph, bytes]]);
    port.postMessage(graph, [buffer]);
    const response = await Promise.race([reply.promise, this.#runtime.failure]);
    if (response === null || typeof response !== "object")
      throw new Error("Expected a reply graph");
    const received: unknown = Reflect.get(response, "bytes");
    const map: unknown = Reflect.get(response, "map");
    if (!(received instanceof Uint8Array) || !(map instanceof Map))
      throw new Error("Reply lost its native values");
    return {
      detached: buffer.byteLength === 0,
      bytes: [...received],
      alias: received === Reflect.get(response, "alias"),
      cycle: response === Reflect.get(response, "self"),
      map: map.get(response) === received,
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#runtime.dispose();
    } finally {
      this.#ports.clear();
    }
  }
}

export default class extends WorkerEntrypoint {
  async open(ports: RpcStub<NodeWorkerPortOwner>, owner: string) {
    const runtime = new NodeWorkerPorts(createNodeWorkerPortContext(owner, ports));
    try {
      await runtime.drain();
      return new PortClient(runtime);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }
}
