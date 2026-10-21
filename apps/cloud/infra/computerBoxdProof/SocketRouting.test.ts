import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  RUNNER_PROTOCOL_VERSION,
  runnerFrame,
  threadFrame,
  type RunnerHello,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunnerCommandConfig } from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { ThreadId } from "@t3tools/contracts";
import { createRunnerMachineRuntime } from "../../src/computer/RunnerMachineRuntime.ts";
import {
  RunnerMachineSockets,
  type RunnerMachineSocketsOptions,
} from "../../src/computer/RunnerMachineSockets.ts";
import type { MachineCommandRuntimeBinding } from "../../src/computer/MachineWorkspace.ts";
import type { MachineRunnerOwner } from "../../src/computer/RunnerMachineRuntime.ts";
import type { runComputerBoxdProof } from "./Session.ts";
import {
  createWorker as createProofWorker,
  deferred,
  FakeStorage as ProofStorage,
  request as proofRequest,
  status as proofStatus,
} from "./AdmissionTestHelpers.ts";

const ports = vi.hoisted(() => ({
  decodeSeed: vi.fn(),
  openProvider: vi.fn(),
  runProof: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("./SeedProtocol.ts", () => ({ decodeProofSeed: ports.decodeSeed }));
vi.mock("./Provider.ts", () => ({ openProofProvider: ports.openProvider }));
vi.mock("./Session.ts", () => ({ runComputerBoxdProof: ports.runProof }));
vi.mock("./Recovery.ts", () => ({ recoverComputerBoxdProof: vi.fn() }));
vi.mock("./Ownership.ts", () => ({
  decodeProofState: (state: unknown) => state,
  ProofOwnership: class {
    readonly client = { close: async () => undefined };

    private readonly storage: { put(key: string, value: unknown): Promise<void> };

    constructor(storage: { put(key: string, value: unknown): Promise<void> }) {
      this.storage = storage;
    }

    save(state: unknown) {
      return this.storage.put("proof-state", state);
    }

    cleanup() {
      return Promise.resolve(true);
    }
  },
}));

import type { ComputerBoxdProof } from "./worker.ts";

type ProofSessionInput = Parameters<typeof runComputerBoxdProof>[0];

interface SocketSession {
  readonly adapter: RunnerMachineSockets;
  readonly config: Promise<RunnerCommandConfig>;
  readonly binding: Promise<MachineCommandRuntimeBinding>;
  readonly signal: AbortSignal;
  readonly finish: () => void;
  readonly fail: (error: Error) => void;
  readonly nativeClosureCalls: () => number;
}

const seed = { sourceCommit: "a".repeat(40), runner: { sha256: "runner" } };
const command = {
  executable: "/bin/bash",
  argv: ["bash", "-c", "exit 17"],
  cwd: "/workspace",
  env: { PROOF: "socket-routing" },
};
const machine = { id: "socket-proof-machine", generation: 7, release: async () => undefined };
const operationId = "socket-proof-command";
const threadId = ThreadId.make("socket-proof-thread");

class WebSocketRequestResponsePairFixture {
  readonly request: string;
  readonly response: string;

  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

beforeAll(() => vi.stubGlobal("WebSocketRequestResponsePair", WebSocketRequestResponsePairFixture));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  ports.decodeSeed.mockResolvedValue(seed);
  ports.openProvider.mockResolvedValue({});
});

function socketFixture() {
  let readyState: number = WebSocket.OPEN;
  const sent: string[] = [];
  const socket = {
    get readyState() {
      return readyState;
    },
    accept: vi.fn(),
    addEventListener: vi.fn(),
    send(value: string) {
      sent.push(value);
    },
    close: vi.fn(() => {
      readyState = WebSocket.CLOSING;
    }),
  } as unknown as WebSocket;
  return { socket, sent };
}

function installSessionMock() {
  const entered = deferred<SocketSession>();
  ports.runProof.mockImplementation(async (input: ProofSessionInput) => {
    const launched = deferred<RunnerCommandConfig>();
    const finish = deferred<void>();
    const signal = input.signal;
    let nativeClosureCalls = 0;
    const options: RunnerMachineSocketsOptions = {
      ctx: input.ctx,
      endpoint: input.endpoint,
      threadId,
      workspaceReceipt: "/run/proof/workspace.json",
      launch: async (config) => {
        launched.resolve(config);
      },
      quiesce: async (owner: MachineRunnerOwner) => {
        nativeClosureCalls += 1;
        return {
          operationId: owner.operationId,
          machineId: owner.machine.id,
          generation: owner.machine.generation,
          closed: true,
        };
      },
    };
    const adapter = new RunnerMachineSockets(options);
    input.publishSockets(adapter);
    const runtime = createRunnerMachineRuntime(adapter);
    const binding = runtime.attach({
      operationId,
      machine,
      workspace: { canonicalCwd: async (candidate) => candidate.cwd },
      policy: { authorize: async () => undefined },
      signal,
    });
    entered.resolve({
      adapter,
      config: launched.promise,
      binding,
      signal,
      finish: () => finish.resolve(),
      fail: (error) => finish.reject(error),
      nativeClosureCalls: () => nativeClosureCalls,
    });
    await finish.promise;
  });
  return entered.promise;
}

function hello(config: RunnerCommandConfig) {
  const frame: RunnerHello = {
    type: "hello",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    imageVersion: "command-v1",
    machineId: config.machineId,
    threadId,
    generation: config.generation,
    token: config.token,
    lastAckedSequence: 0,
    exec: true,
  };
  return runnerFrame.encode(frame);
}

async function startChild(worker: ComputerBoxdProof, session: SocketSession) {
  const config = await session.config;
  const live = socketFixture();
  session.adapter.accept(live.socket);
  worker.webSocketMessage(live.socket, hello(config));
  const binding = await session.binding;
  const startSent = deferred<string>();
  const originalSend = live.socket.send.bind(live.socket);
  live.socket.send = (value) => {
    if (typeof value !== "string") throw new Error("Expected a text frame");
    originalSend(value);
    const frame = threadFrame.decode(value);
    if (frame.type === "exec.command" && frame.command.type === "start") {
      startSent.resolve(value);
    }
  };
  const spawning = binding.spawn(command, session.signal);
  const frame = threadFrame.decode(await startSent.promise);
  if (frame.type !== "exec.command" || frame.command.type !== "start") {
    throw new Error("Missing Runner start frame");
  }
  worker.webSocketMessage(
    live.socket,
    runnerFrame.encode({
      type: "exec.report",
      report: {
        type: "ack",
        generation: config.generation,
        processId: frame.command.processId,
        operation: "start",
        requestId: frame.command.requestId,
        applied: true,
      },
    }),
  );
  return { live, binding, child: await spawning, start: frame.command };
}

async function startProof() {
  const proof = createProofWorker(new ProofStorage());
  await proof.ready;
  expect((await proofRequest(proof.worker, "/seed", JSON.stringify(seed))).status).toBe(202);
  const sessionPromise = installSessionMock();
  const response = await proofRequest(proof.worker, "/run", JSON.stringify({ seed }));
  expect(response.status).toBe(202);
  const session = await sessionPromise;
  expect(proof.background).toHaveLength(1);
  return { proof, session };
}

describe("computer boxd proof Runner socket routing", () => {
  it("routes authenticated command reports through the DO and retains the run until native closure", async () => {
    const { proof, session } = await startProof();
    let backgroundSettled = false;
    void Promise.all(proof.background).then(() => {
      backgroundSettled = true;
    });

    const { live, binding, child, start } = await startChild(proof.worker, session);
    expect(start).toMatchObject(command);
    expect(backgroundSettled).toBe(false);

    proof.worker.webSocketMessage(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "exit",
          generation: start.generation,
          processId: start.processId,
          sequence: 1,
          exitCode: 17,
        },
      }),
    );
    proof.worker.webSocketMessage(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "closed",
          generation: start.generation,
          processId: start.processId,
          sequence: 2,
        },
      }),
    );

    expect(await child.exited).toEqual({ exitCode: 17, signal: 0, coreDumped: false });
    await child.dispose();
    await binding.quiesce(session.signal);
    expect(session.nativeClosureCalls()).toBe(1);
    await binding.dispose();
    session.finish();
    await Promise.all(proof.background);

    expect(backgroundSettled).toBe(true);
    expect((await proofStatus(proof.worker)).status).toBe("passed");
  });

  it.each(["close", "error"] as const)(
    "routes socket %s as transport loss without attesting native closure",
    async (event) => {
      const { proof, session } = await startProof();
      const { live, binding, child } = await startChild(proof.worker, session);
      const exited = expect(child.exited).rejects.toThrow("Runner connection closed");

      if (event === "close") proof.worker.webSocketClose(live.socket);
      else proof.worker.webSocketError(live.socket);

      await exited;
      expect(session.nativeClosureCalls()).toBe(0);
      await binding.quiesce(session.signal);
      expect(session.nativeClosureCalls()).toBe(1);
      await child.dispose();
      await binding.dispose();
      session.fail(new Error("Runner socket was lost"));
      await Promise.all(proof.background);

      expect((await proofStatus(proof.worker)).status).toBe("failed");
    },
  );
});
