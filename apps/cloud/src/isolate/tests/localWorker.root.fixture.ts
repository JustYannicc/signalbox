import {
  createNodeLocalWorkerThreads,
  openNodeLocalWorkerThread,
} from "../NodeLocalWorkerThreads.ts";
import {
  NodeWorkerPortBroker,
  type NodeWorkerExit,
  type NodeWorkerModuleLoader,
  type NodeWorkerRun,
  type NodeWorkerRunEvents,
  type NodeWorkerStartRequest,
  type NodeWorkerSupervisor,
} from "../NodeWorkerThreads.ts";

const reference = {
  artifactRef: "fixture:1396-local-worker",
  artifactHash: "a".repeat(64),
  sourceIdentity: "local-transport-fixture",
};
const loader: NodeWorkerModuleLoader = {
  reference,
  resolve: (filename) => new URL(String(filename), "file:///hooks/").href,
};

class LocalSupervisor implements NodeWorkerSupervisor {
  readonly #broker: NodeWorkerPortBroker;
  #threadId = 0;
  #owner = 0;
  readonly order: string[] = [];

  constructor(broker: NodeWorkerPortBroker) {
    this.#broker = broker;
  }

  allocateThreadId = () => ++this.#threadId;

  async start(
    request: NodeWorkerStartRequest,
    events: NodeWorkerRunEvents,
  ): Promise<NodeWorkerRun> {
    const child = await openNodeLocalWorkerThread({
      broker: this.#broker,
      supervisor: this,
      moduleLoader: loader,
      request,
      context: {
        owner: `1396/hook/${++this.#owner}`,
        allocateThreadId: this.allocateThreadId,
        output: events.output,
      },
    });
    const abort = new AbortController();
    const finished = Promise.withResolvers<NodeWorkerExit>();
    let terminated = false;
    const work = (async () => {
      try {
        const program = await import("./localWorker.program.fixture.ts");
        this.order.push("entry loaded");
        await events.online();
        await program.runLocalWorkerFixture(child.module, abort.signal);
        this.order.push("entry joined");
        await child.drain();
      } catch (error) {
        await events.error(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        await child.dispose();
        await this.#broker.drain();
        this.order.push("callbacks fenced");
      }
    })();
    void work.then(
      () => finished.resolve({ code: terminated ? 1 : 0, stopped: true }),
      finished.reject,
    );
    return {
      wait: () => finished.promise,
      terminate: async () => {
        terminated = true;
        abort.abort();
        return finished.promise;
      },
      writeStdin: async () => {
        throw new Error("This fixture has no stdin");
      },
    };
  }
}

export default {
  async fetch() {
    const broker = new NodeWorkerPortBroker();
    const supervisor = new LocalSupervisor(broker);
    const parent = createNodeLocalWorkerThreads({
      broker,
      supervisor,
      moduleLoader: loader,
      context: {
        owner: "1396/parent",
        isMainThread: true,
        threadId: 0,
        env: {},
        argv: [],
        execArgv: [],
        allocateThreadId: supervisor.allocateThreadId,
        output: async () => undefined,
      },
    });
    try {
      const stamp = new SharedArrayBuffer(36);
      const marks = new SharedArrayBuffer(12);
      const stampView = new Int32Array(stamp);
      const marksView = new Int32Array(marks);
      const worker = new parent.module.Worker("./hook.mjs", { workerData: { stamp, marks } });
      const online: string[] = [];
      worker.on("online", () => online.push("online"));
      const loaded = Promise.withResolvers<unknown>();
      const exited = Promise.withResolvers<number>();
      worker.once("message", loaded.resolve);
      worker.once("exit", exited.resolve);
      const { port1, port2 } = new parent.module.MessageChannel();
      const buffer = Uint8Array.from([0, 127, 255]).buffer;
      worker.postMessage({ type: "load", port: port2, bytes: new Uint8Array(buffer) }, [
        port2,
        buffer,
      ]);
      const detached = buffer.byteLength === 0;
      const oldHandleDetached = port2.hasRef() === false;
      port2.postMessage("old detached handle");
      const load = await Promise.race([loaded.promise, parent.failure]);
      const messages: unknown[] = [];
      const result = Promise.withResolvers<void>();
      const terminal = Promise.withResolvers<void>();
      port1.on("message", (message) => {
        messages.push(message);
        if (
          message !== null &&
          typeof message === "object" &&
          Reflect.get(message, "type") === "result"
        )
          result.resolve();
        else terminal.resolve();
      });
      Atomics.store(marksView, 0, 41);
      port1.postMessage("dispatch");
      await Promise.race([result.promise, parent.failure]);
      const sharedWrites = [Atomics.load(stampView, 0), Atomics.load(marksView, 1)];
      port1.postMessage("finish");
      await Promise.race([terminal.promise, parent.failure]);
      const exit = await Promise.race([exited.promise, parent.failure]);
      await parent.drain();
      await parent.dispose();
      await broker.drain();
      return Response.json({
        detached,
        oldHandleDetached,
        load,
        messages,
        sharedWrites,
        exit,
        threadId: worker.threadId,
        online,
        order: supervisor.order,
        ports: broker.residentPorts,
      });
    } finally {
      await parent.dispose();
      await broker.drain();
    }
  },
};
