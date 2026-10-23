import { describe, expect, it } from "vite-plus/test";
import {
  createNodeLocalWorkerThreads,
  openNodeLocalWorkerThread,
} from "../NodeLocalWorkerThreads.ts";
import {
  NodeWorkerPortBroker,
  createNodeWorkerThreads,
  type NodeWorkerModuleLoader,
  type NodeWorkerPortContext,
  type NodeWorkerRun,
  type NodeWorkerRunEvents,
  type NodeWorkerStartRequest,
  type NodeWorkerSupervisor,
  type NodeWorkerThreadContext,
} from "../NodeWorkerThreads.ts";

const graph = {
  artifactRef: "fixture:local-worker",
  artifactHash: "b".repeat(64),
  sourceIdentity: "local-fixture",
};
const entryUrl = "file:///fixtures/local-worker.mjs";
const errorUrl = "file:///fixtures/local-worker-error.mjs";
const loader: NodeWorkerModuleLoader = {
  reference: graph,
  resolve(filename) {
    return filename instanceof URL ? filename.href : new URL(filename, "file:///fixtures/").href;
  },
};

type WorkerModule = ReturnType<typeof createNodeWorkerThreads>["module"];
type Guest = (input: {
  readonly module: WorkerModule;
  readonly finish: (code?: number) => Promise<void>;
  readonly output: NodeWorkerRunEvents["output"];
}) => void | Promise<void>;

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function portContext(owner: string, broker: NodeWorkerPortBroker): NodeWorkerPortContext {
  return {
    owner,
    connect: async (receiver) => broker.connect(owner, receiver),
    disconnect: () => broker.disconnect(owner),
  };
}

class InProcessSupervisor implements NodeWorkerSupervisor {
  readonly requests: NodeWorkerStartRequest[] = [];
  readonly guestStarted = deferred<void>();
  readonly stopEntered = deferred<void>();
  readonly stopGate = deferred<void>();
  readonly #guests = new Map<string, Guest>();
  readonly #broker: NodeWorkerPortBroker;
  readonly #allocateThreadId: () => number;
  #runSequence = 0;
  #holdStop = false;

  constructor(broker: NodeWorkerPortBroker, allocateThreadId: () => number) {
    this.#broker = broker;
    this.#allocateThreadId = allocateThreadId;
  }

  add(url: string, guest: Guest): void {
    this.#guests.set(url, guest);
  }

  holdStop(): void {
    this.#holdStop = true;
  }

  releaseStop(): void {
    this.stopGate.resolve();
  }

  async start(
    request: NodeWorkerStartRequest,
    events: NodeWorkerRunEvents,
  ): Promise<NodeWorkerRun> {
    this.requests.push(request);
    const owner = `local-worker-${++this.#runSequence}`;
    const child = await openNodeLocalWorkerThread({
      broker: this.#broker,
      supervisor: this,
      moduleLoader: loader,
      context: {
        owner,
        allocateThreadId: this.#allocateThreadId,
        output: async () => undefined,
      },
      request,
    });
    const settled = deferred<{ readonly code: number; readonly stopped: true }>();
    let stopped: { readonly code: number; readonly stopped: true } | undefined;
    let stopping: Promise<{ readonly code: number; readonly stopped: true }> | undefined;
    const stop = async (code: number) => {
      if (stopped !== undefined) return stopped;
      if (stopping !== undefined) return stopping;
      stopping = (async () => {
        this.stopEntered.resolve();
        if (this.#holdStop) await this.stopGate.promise;
        await child.dispose();
        await this.#broker.drain();
        stopped = { code, stopped: true };
        settled.resolve(stopped);
        return stopped;
      })();
      return stopping;
    };

    void (async () => {
      try {
        await events.online();
        const url = request.entry.kind === "file" ? request.entry.url : request.entry.source;
        const guest = this.#guests.get(url);
        if (guest === undefined) throw new Error(`No local fixture guest for ${url}`);
        this.guestStarted.resolve();
        await guest({
          module: child.module,
          finish: (code = 0) => stop(code).then(() => undefined),
          output: events.output,
        });
      } catch (error) {
        await events.error(error instanceof Error ? error : new Error(String(error)));
        await stop(1);
      }
    })();

    return {
      wait: () => settled.promise,
      terminate: () => stop(1),
      writeStdin: async () => undefined,
    };
  }
}

function harness() {
  const broker = new NodeWorkerPortBroker();
  let nextThreadId = 1;
  const allocateThreadId = () => nextThreadId++;
  const supervisor = new InProcessSupervisor(broker, allocateThreadId);
  const context: Omit<NodeWorkerThreadContext, "ports"> & { readonly owner: string } = {
    owner: "local-main",
    threadId: 0,
    isMainThread: true,
    env: { HOME: "/home/test" },
    argv: ["node", "main.js"],
    execArgv: [],
    allocateThreadId,
    output: async () => undefined,
  };
  const threads = createNodeLocalWorkerThreads({
    broker,
    supervisor,
    moduleLoader: loader,
    context,
  });
  return { broker, supervisor, threads };
}

describe("same-isolate worker_threads transport", () => {
  it("keeps SAB backing shared through the start packet and transfers ports and ArrayBuffers", async () => {
    const h = harness();
    const shared = new SharedArrayBuffer(16);
    const marks = new Uint32Array(shared);
    marks[0] = 0x2a;
    const buffer = new ArrayBuffer(3);
    new Uint8Array(buffer).set([8, 16, 32]);
    const channel = new h.threads.module.MessageChannel();
    const order: string[] = [];
    const logicalPortReply = deferred<readonly number[]>();
    channel.port1.on("message", (value) => {
      order.push("logical-port");
      logicalPortReply.resolve([...(value as { readonly bytes: Uint8Array }).bytes]);
    });

    h.threads.module.setEnvironmentData("fixture", { mode: "in-process" });
    h.supervisor.add(entryUrl, async ({ module, finish }) => {
      const data = module.workerData as {
        readonly shared: SharedArrayBuffer;
        readonly marks: Uint32Array;
        readonly buffer: ArrayBuffer;
        readonly logicalPort: {
          postMessage(value: unknown, transferList?: readonly object[]): void;
        };
      };
      expect(module.isMainThread).toBe(false);
      expect(module.threadId).toBe(1);
      expect(data.marks.buffer).toBe(data.shared);
      expect(data.marks[0]).toBe(0x2a);
      expect(module.getEnvironmentData("fixture")).toEqual({ mode: "in-process" });
      data.marks[1] = 0x11;
      const postLogicalMessage = data.logicalPort.postMessage.bind(data.logicalPort);
      postLogicalMessage({ bytes: new Uint8Array(data.buffer) }, [data.buffer]);
      expect(data.buffer.byteLength).toBe(0);
      const parentPort = module.parentPort;
      if (parentPort === null) throw new Error("local worker has no parentPort");
      const postParentMessage = parentPort.postMessage.bind(parentPort);
      postParentMessage({ kind: "ready", mark: data.marks[1] });
      parentPort.on("message", (value) => {
        if ((value as { readonly kind?: string }).kind !== "continue") return;
        expect(data.marks[2]).toBe(0x22);
        data.marks[3] = 0x33;
        postParentMessage({ kind: "terminal-ack", mark: data.marks[3] });
        void finish(0);
      });
    });

    const worker = new h.threads.module.Worker(entryUrl, {
      workerData: { shared, marks, buffer, logicalPort: channel.port2 },
      transferList: [buffer, channel.port2],
    });
    const postWorkerMessage = worker.postMessage.bind(worker);
    expect(buffer.byteLength).toBe(0);
    const terminalAck = deferred<number>();
    const exit = deferred<number>();
    worker.on("message", (value) => {
      const message = value as { readonly kind: string; readonly mark: number };
      order.push(message.kind);
      if (message.kind === "ready") {
        expect(message.mark).toBe(0x11);
        expect(marks[1]).toBe(0x11);
        marks[2] = 0x22;
        postWorkerMessage({ kind: "continue" });
      } else if (message.kind === "terminal-ack") {
        expect(marks[3]).toBe(0x33);
        terminalAck.resolve(message.mark);
      }
    });
    worker.on("exit", (code) => {
      order.push("exit");
      exit.resolve(code);
    });

    expect(await logicalPortReply.promise).toEqual([8, 16, 32]);
    expect(await terminalAck.promise).toBe(0x33);
    expect(await exit.promise).toBe(0);
    expect(order.indexOf("terminal-ack")).toBeLessThan(order.indexOf("exit"));
    expect(h.supervisor.requests[0]?.graph).toEqual(graph);
    expect(h.supervisor.requests[0]?.entry).toEqual({ kind: "file", url: entryUrl });
    expect(h.supervisor.requests[0]?.input.ports).toHaveLength(2);
    await h.threads.drain();
    await h.threads.dispose();
    await h.broker.drain();
  });

  it("preserves transfers on bad clones and rejects SAB transfer lists before any detach", async () => {
    const h = harness();
    const channel = new h.threads.module.MessageChannel();
    const nextMessage = deferred<string>();
    channel.port1.once("message", (value) => nextMessage.resolve(String(value)));
    const buffer = new ArrayBuffer(4);
    expect(
      () =>
        new h.threads.module.Worker(entryUrl, {
          workerData: { invalid: () => undefined, port: channel.port2 },
          transferList: [buffer, channel.port2],
        }),
    ).toThrow(/DataCloneError|clone/i);
    expect(buffer.byteLength).toBe(4);
    channel.port2.postMessage("still-attached-after-bad-clone");
    expect(await nextMessage.promise).toBe("still-attached-after-bad-clone");

    const secondBuffer = new ArrayBuffer(4);
    const shared = new SharedArrayBuffer(4);
    expect(
      () =>
        new h.threads.module.Worker(entryUrl, {
          workerData: { shared, port: channel.port2 },
          transferList: [secondBuffer, shared, channel.port2],
        }),
    ).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    expect(secondBuffer.byteLength).toBe(4);
    const secondMessage = deferred<string>();
    channel.port1.once("message", (value) => secondMessage.resolve(String(value)));
    channel.port2.postMessage("still-attached-after-SAB-transfer");
    expect(await secondMessage.promise).toBe("still-attached-after-SAB-transfer");
    await h.threads.dispose();
    await h.broker.drain();
  });

  it("keeps generic worker_threads SAB rejection and requires confirmed termination", async () => {
    const broker = new NodeWorkerPortBroker();
    const generic = createNodeWorkerThreads({
      supervisor: {
        start: async () => {
          throw new Error("must not start");
        },
      },
      moduleLoader: loader,
      context: {
        ports: portContext("generic-main", broker),
        threadId: 0,
        isMainThread: true,
        env: {},
        argv: [],
        execArgv: [],
        allocateThreadId: () => 1,
        output: async () => undefined,
      },
    });
    const shared = new SharedArrayBuffer(8);
    expect(() => new generic.module.Worker(entryUrl, { workerData: shared })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    expect(shared.byteLength).toBe(8);
    await generic.dispose();

    const h = harness();
    h.supervisor.add(entryUrl, async () => undefined);
    h.supervisor.holdStop();
    const worker = new h.threads.module.Worker(entryUrl);
    const exit = deferred<number>();
    worker.on("exit", exit.resolve);
    await h.supervisor.guestStarted.promise;
    const terminating = worker.terminate();
    await h.supervisor.stopEntered.promise;
    expect(worker.threadId).toBe(1);
    h.supervisor.releaseStop();
    expect(await terminating).toBe(1);
    expect(await exit.promise).toBe(1);
    expect(worker.threadId).toBe(-1);
    await h.threads.dispose();
    await h.broker.drain();
  });

  it("handles guest errors without poisoning drain or later workers", async () => {
    const h = harness();
    h.supervisor.add(errorUrl, async ({ output }) => {
      await output("stdout", new TextEncoder().encode("local worker output"));
      throw new Error("local guest failed");
    });
    const worker = new h.threads.module.Worker(errorUrl, { stdout: true });
    const stdout = deferred<string>();
    const error = deferred<string>();
    const exit = deferred<number>();
    worker.stdout?.on("data", (chunk: Uint8Array) => stdout.resolve(Buffer.from(chunk).toString()));
    worker.on("error", (value) => error.resolve((value as Error).message));
    worker.on("exit", exit.resolve);
    expect(await error.promise).toBe("local guest failed");
    expect(await exit.promise).toBe(1);
    expect(await stdout.promise).toBe("local worker output");
    await h.threads.drain();

    const continuedMessage = deferred<string>();
    const continuedExit = deferred<number>();
    h.supervisor.add(entryUrl, async ({ module, finish }) => {
      const parentPort = module.parentPort;
      if (parentPort === null) throw new Error("local worker has no parentPort");
      const postParentMessage = parentPort.postMessage.bind(parentPort);
      postParentMessage("after-handled-error");
      void finish(0);
    });
    const continuedWorker = new h.threads.module.Worker(entryUrl);
    continuedWorker.on("message", (value) => continuedMessage.resolve(String(value)));
    continuedWorker.on("exit", continuedExit.resolve);
    expect(await continuedMessage.promise).toBe("after-handled-error");
    expect(await continuedExit.promise).toBe(0);
    await h.threads.drain();
    await h.threads.dispose();
    await h.broker.drain();
  });

  it("rejects a nonlocal broker even when it matches the broker shape", () => {
    const invalid = {} as NodeWorkerPortBroker;
    expect(() =>
      createNodeLocalWorkerThreads({
        broker: invalid,
        supervisor: {
          start: async () => {
            throw new Error("must not start");
          },
        },
        moduleLoader: loader,
        context: {
          owner: "invalid-owner",
          threadId: 0,
          isMainThread: true,
          env: {},
          argv: [],
          execArgv: [],
          allocateThreadId: () => 1,
          output: async () => undefined,
        },
      }),
    ).toThrow(/local NodeWorkerPortBroker/);
  });

  it("rejects a mismatched graph before connecting the child owner", async () => {
    const broker = new NodeWorkerPortBroker();
    const supervisor: NodeWorkerSupervisor = {
      start: async () => {
        throw new Error("must not start");
      },
    };
    const context = {
      owner: "graph-check-owner",
      allocateThreadId: () => 1,
      output: async () => undefined,
    };
    await expect(
      openNodeLocalWorkerThread({
        broker,
        supervisor,
        moduleLoader: loader,
        context,
        request: { graph: { ...graph, artifactHash: "c".repeat(64) } } as NodeWorkerStartRequest,
      }),
    ).rejects.toThrow("worker graph identity was not verified");

    const parent = createNodeLocalWorkerThreads({
      broker,
      supervisor,
      moduleLoader: loader,
      context: {
        ...context,
        threadId: 0,
        isMainThread: true,
        env: {},
        argv: [],
        execArgv: [],
      },
    });
    await parent.drain();
    await parent.dispose();
  });
});
