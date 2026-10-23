import { describe, expect, it } from "vite-plus/test";
import {
  createNodeWorkerThreads,
  NodeWorkerPortBroker,
  type NodeWorkerExit,
  type NodeWorkerModuleLoader,
  type NodeWorkerRun,
  type NodeWorkerRunEvents,
  type NodeWorkerStartRequest,
  type NodeWorkerSupervisor,
  type NodeWorkerThreadContext,
} from "../NodeWorkerThreads.ts";

const graph = {
  artifactRef: "fixture:worker",
  artifactHash: "a".repeat(64),
  sourceIdentity: "fixture",
};
const echoUrl = "file:///fixtures/echo.mjs";
const errorUrl = "file:///fixtures/error.mjs";
const transferUrl = "file:///fixtures/transfer.mjs";
const fileLoader: NodeWorkerModuleLoader = {
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

class InProcessSupervisor implements NodeWorkerSupervisor {
  readonly requests: NodeWorkerStartRequest[] = [];
  readonly stdinWrites: Uint8Array[] = [];
  readonly started = deferred<void>();
  readonly #guests = new Map<string, Guest>();
  #holdOnline = false;
  #onlineGate = deferred<void>();
  #startFailure: Error | undefined;
  #waitFailure: Error | undefined;
  #terminateFailure: Error | undefined;
  readonly #broker: NodeWorkerPortBroker;
  readonly #loader: NodeWorkerModuleLoader;
  readonly #allocateThreadId: () => number;
  #runSequence = 0;

  constructor(
    broker: NodeWorkerPortBroker,
    loader: NodeWorkerModuleLoader,
    allocateThreadId: () => number,
  ) {
    this.#broker = broker;
    this.#loader = loader;
    this.#allocateThreadId = allocateThreadId;
  }

  add(url: string, guest: Guest): void {
    this.#guests.set(url, guest);
  }
  holdOnline(): void {
    this.#holdOnline = true;
  }
  releaseOnline(): void {
    this.#onlineGate.resolve();
  }
  failStart(error: Error): void {
    this.#startFailure = error;
  }
  failWait(error: Error): void {
    this.#waitFailure = error;
  }
  failTerminate(error: Error): void {
    this.#terminateFailure = error;
  }

  async start(
    request: NodeWorkerStartRequest,
    events: NodeWorkerRunEvents,
  ): Promise<NodeWorkerRun> {
    this.requests.push(request);
    if (this.#startFailure !== undefined) throw this.#startFailure;
    const owner = `worker-run-${++this.#runSequence}`;
    if (
      request.graph.artifactRef !== this.#loader.reference.artifactRef ||
      request.graph.artifactHash !== this.#loader.reference.artifactHash ||
      request.graph.sourceIdentity !== this.#loader.reference.sourceIdentity
    )
      throw new Error("worker graph identity was not verified");
    const value = request.input.value as {
      readonly workerData: unknown;
      readonly parentPort: object;
    };
    const parentPort = request.input.ports.find(
      (entry) => entry.marker === value.parentPort,
    )?.handle;
    if (parentPort === undefined) throw new Error("worker start did not transfer its parentPort");

    let child: ReturnType<typeof createNodeWorkerThreads> | undefined;
    let stopped: NodeWorkerExit | undefined;
    const settled = deferred<NodeWorkerExit>();
    let stopping: Promise<NodeWorkerExit> | undefined;
    const stop = async (code: number): Promise<NodeWorkerExit> => {
      if (stopped !== undefined) return stopped;
      if (stopping !== undefined) return stopping;
      stopping = (async () => {
        await child?.dispose();
        await this.#broker.drain();
        stopped = { code, stopped: true };
        settled.resolve(stopped);
        return stopped;
      })();
      return stopping;
    };

    child = createNodeWorkerThreads({
      supervisor: this,
      moduleLoader: this.#loader,
      context: {
        ports: {
          owner,
          connect: async (receiver) => this.#broker.connect(owner, receiver),
          disconnect: () => this.#broker.disconnect(owner),
        },
        threadId: request.threadId,
        isMainThread: false,
        parentPort,
        workerData: value.workerData,
        environmentData: new Map(
          request.environmentData.value as readonly (readonly [unknown, unknown])[],
        ),
        env: request.env,
        argv: request.argv,
        execArgv: request.execArgv,
        resourceLimits: request.resourceLimits,
        allocateThreadId: this.#allocateThreadId,
        output: async () => undefined,
      },
    });
    await this.#broker.transfer(request.owner, owner, request.input);

    const run: NodeWorkerRun = {
      wait: () =>
        this.#waitFailure === undefined ? settled.promise : Promise.reject(this.#waitFailure),
      terminate: () =>
        this.#terminateFailure === undefined ? stop(1) : Promise.reject(this.#terminateFailure),
      writeStdin: async (bytes) => {
        if (bytes !== null) this.stdinWrites.push(bytes);
      },
    };
    this.started.resolve();
    void (async () => {
      if (this.#holdOnline) await this.#onlineGate.promise;
      if (stopped !== undefined) return;
      try {
        await events.online();
        const entry = request.entry.kind === "file" ? request.entry.url : request.entry.source;
        const guest = this.#guests.get(entry);
        if (guest === undefined) throw new Error(`No fixture guest for ${entry}`);
        await guest({
          module: child!.module,
          finish: (code = 0) => stop(code).then(() => undefined),
          output: events.output,
        });
      } catch (error) {
        await events.error(error instanceof Error ? error : new Error(String(error)));
        await stop(1);
      }
    })();
    return run;
  }
}

function harness() {
  const broker = new NodeWorkerPortBroker();
  let nextThreadId = 1;
  const allocateThreadId = () => nextThreadId++;
  const supervisor = new InProcessSupervisor(broker, fileLoader, allocateThreadId);
  const outputs: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const context: NodeWorkerThreadContext = {
    ports: {
      owner: "main",
      connect: async (receiver) => broker.connect("main", receiver),
      disconnect: () => broker.disconnect("main"),
    },
    threadId: 0,
    isMainThread: true,
    env: { PATH: "/usr/bin", HOME: "/home/test" },
    argv: ["node", "main.js"],
    execArgv: ["--enable-source-maps"],
    allocateThreadId,
    output: async (stream, bytes) => {
      outputs.push({ stream, text: Buffer.from(bytes).toString() });
    },
  };
  return {
    facade: createNodeWorkerThreads({ supervisor, moduleLoader: fileLoader, context }),
    supervisor,
    broker,
    outputs,
  };
}

describe("Node worker_threads facade", () => {
  it("clones constructor input and delivers queued messages after online", async () => {
    const h = harness();
    const order: string[] = [];
    const result = deferred<unknown>();
    const output = deferred<string>();
    h.supervisor.add(echoUrl, async ({ module, finish, output: writeOutput }) => {
      if (module.parentPort === null) throw new Error("worker has no parentPort");
      await writeOutput("stdout", new TextEncoder().encode("worker stdout"));
      module.parentPort.on("message", (message) => {
        module.parentPort?.postMessage({
          message,
          workerData: module.workerData,
          environmentData: module.getEnvironmentData("config"),
        });
        void finish(0);
      });
    });
    h.supervisor.holdOnline();
    const environment = { mode: "snapshot" };
    h.facade.module.setEnvironmentData("config", environment);
    const workerData = { value: 1 };
    const worker = new h.facade.module.Worker(new URL(echoUrl), {
      name: "scale-fixture",
      workerData,
      argv: ["--child"],
      env: { ONLY: "child" },
      execArgv: ["--trace-warnings"],
      resourceLimits: { maxOldGenerationSizeMb: 24 },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    environment.mode = "changed after construction";
    workerData.value = 2;
    worker.on("online", () => order.push("online"));
    worker.on("message", (message) => {
      order.push("message");
      result.resolve(message);
    });
    worker.stdout?.on("data", (chunk: Uint8Array) => output.resolve(Buffer.from(chunk).toString()));
    const exited = deferred<number>();
    worker.on("exit", (code) => {
      order.push("exit");
      exited.resolve(code);
    });
    worker.unref();
    expect(worker.hasRef()).toBe(false);
    expect(h.facade.referenced).toBe(false);
    worker.ref();
    expect(worker.hasRef()).toBe(true);
    expect(h.facade.referenced).toBe(true);
    worker.postMessage("queued before online");
    const stdinWritten = deferred<void>();
    worker.stdin?.write("stdin bytes", () => stdinWritten.resolve());
    await h.supervisor.started.promise;
    await stdinWritten.promise;
    h.supervisor.releaseOnline();

    expect(await result.promise).toEqual({
      message: "queued before online",
      workerData: { value: 1 },
      environmentData: { mode: "snapshot" },
    });
    expect(await exited.promise).toBe(0);
    expect(await output.promise).toBe("worker stdout");
    expect(
      Buffer.concat(h.supervisor.stdinWrites.map((chunk) => Buffer.from(chunk))).toString(),
    ).toBe("stdin bytes");
    expect(order).toEqual(["online", "message", "exit"]);
    expect(worker.threadId).toBe(-1);
    expect(worker.stdin).not.toBeNull();
    expect(worker.stdout).not.toBeNull();
    expect(worker.stderr).not.toBeNull();
    expect(h.supervisor.requests[0]).toMatchObject({
      graph,
      entry: { kind: "file", url: echoUrl },
      name: "scale-fixture",
      argv: ["--child"],
      env: { ONLY: "child" },
      execArgv: ["--trace-warnings"],
      resourceLimits: { maxOldGenerationSizeMb: 24 },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    await h.facade.drain();
    await h.facade.dispose();
  });

  it("moves MessagePorts with posted values and keeps both endpoints usable", async () => {
    const h = harness();
    const reply = deferred<unknown>();
    h.supervisor.add(transferUrl, async ({ module, finish }) => {
      module.parentPort?.on("message", (value) => {
        const port = (value as { port: { postMessage(value: unknown): void } }).port;
        port.postMessage("through transferred port");
        void finish(0);
      });
    });
    const channel = new h.facade.module.MessageChannel();
    channel.port1.on("message", (message) => reply.resolve(message));
    const worker = new h.facade.module.Worker(transferUrl);
    const exited = deferred<number>();
    worker.on("exit", (code) => exited.resolve(code));
    worker.postMessage({ port: channel.port2 }, [channel.port2]);

    expect(await reply.promise).toBe("through transferred port");
    expect(await exited.promise).toBe(0);
    await h.facade.drain();
    await h.facade.dispose();
  });

  it("leaves transferables attached when constructor cloning fails", async () => {
    const h = harness();
    const buffer = new ArrayBuffer(8);
    expect(
      () =>
        new h.facade.module.Worker(echoUrl, {
          workerData: { buffer, invalid: () => undefined },
          transferList: [buffer],
        }),
    ).toThrow(/clone|DataCloneError/i);
    expect(buffer.byteLength).toBe(8);
    const shared = new SharedArrayBuffer(8);
    expect(() => new h.facade.module.Worker(echoUrl, { workerData: shared })).toThrow(
      /SharedArrayBuffer/,
    );
    expect(shared.byteLength).toBe(8);
    await h.facade.drain();
    await h.facade.dispose();
  });

  it("disposes a worker whose startup and queued message are still in flight", async () => {
    const h = harness();
    h.supervisor.holdOnline();
    h.supervisor.add(echoUrl, async () => undefined);
    const worker = new h.facade.module.Worker(echoUrl);
    const exited = deferred<number>();
    worker.on("exit", (code) => exited.resolve(code));
    worker.postMessage("queued");
    await h.supervisor.started.promise;

    const disposal = h.facade.dispose();
    expect(await worker.terminate()).toBe(1);
    expect(await exited.promise).toBe(1);
    expect(worker.threadId).toBe(-1);
    await disposal;
    expect(await worker.terminate()).toBe(1);
    h.supervisor.releaseOnline();
  });

  it("emits worker error before its acknowledged nonzero exit", async () => {
    const h = harness();
    const order: string[] = [];
    h.supervisor.add(errorUrl, () => {
      throw new Error("guest failed");
    });
    const worker = new h.facade.module.Worker(errorUrl);
    const exited = deferred<number>();
    worker.on("error", (error) => {
      order.push((error as Error).message);
    });
    worker.on("exit", (code) => {
      order.push(`exit:${code}`);
      exited.resolve(code);
    });

    expect(await exited.promise).toBe(1);
    expect(order).toEqual(["guest failed", "exit:1"]);
    await h.facade.drain();
    await h.facade.dispose();
  });

  it("rejects drain on start failure without inventing an exit", async () => {
    const h = harness();
    h.supervisor.failStart(new Error("worker start failed"));
    const worker = new h.facade.module.Worker(echoUrl);
    let exits = 0;
    worker.on("error", () => undefined);
    worker.on("exit", () => {
      exits++;
    });

    await expect(h.facade.drain()).rejects.toThrow("worker start failed");
    expect(worker.threadId).toBe(1);
    expect(exits).toBe(0);
    await expect(h.facade.dispose()).rejects.toThrow("Worker threads disposal failed");
    expect(worker.threadId).toBe(1);
    expect(exits).toBe(0);
  });

  it("rejects drain when wait and terminate fail without reporting a stop", async () => {
    const h = harness();
    h.supervisor.add(echoUrl, async () => undefined);
    h.supervisor.failWait(new Error("worker wait failed"));
    h.supervisor.failTerminate(new Error("worker stop unconfirmed"));
    const worker = new h.facade.module.Worker(echoUrl);
    let exits = 0;
    worker.on("error", () => undefined);
    worker.on("exit", () => {
      exits++;
    });

    await expect(h.facade.drain()).rejects.toThrow("worker wait failed");
    expect(worker.threadId).toBe(1);
    expect(exits).toBe(0);
    await expect(h.facade.dispose()).rejects.toThrow("Worker threads disposal failed");
    expect(worker.threadId).toBe(1);
    expect(exits).toBe(0);
  });

  it("passes eval entries and rejects unsupported worker options", async () => {
    const h = harness();
    h.supervisor.add("parentPort.postMessage('eval')", async ({ module, finish, output }) => {
      await output("stderr", new TextEncoder().encode("un-piped stderr"));
      module.parentPort?.postMessage("eval");
      await finish(0);
    });
    const value = deferred<unknown>();
    const worker = new h.facade.module.Worker("parentPort.postMessage('eval')", { eval: true });
    worker.on("message", value.resolve);
    expect(await value.promise).toBe("eval");
    await h.facade.drain();
    expect(h.outputs).toEqual([{ stream: "stderr", text: "un-piped stderr" }]);
    expect(h.supervisor.requests[0]?.entry).toEqual({
      kind: "eval",
      source: "parentPort.postMessage('eval')",
    });
    expect(h.supervisor.requests[0]?.argv).toEqual([]);
    expect(() => new h.facade.module.Worker(echoUrl, { env: h.facade.module.SHARE_ENV })).toThrow(
      /SHARE_ENV/,
    );
    expect(() => new h.facade.module.Worker(echoUrl, { unsupportedOption: true })).toThrow(
      /unsupported/,
    );
    expect(() => worker.getHeapSnapshot()).toThrow(/not supported/);
    expect(() => worker.cpuUsage()).toThrow(/not supported/);
    await h.facade.dispose();
  });
});
