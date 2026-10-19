// @effect-diagnostics cryptoRandomUUID:off - this Worker socket adapter creates private launch tokens outside an Effect runtime.
import {
  COMMAND_RUNNER_CONNECT_PATH,
  RunnerCommandConfigJson,
  type RunnerCommandConfig,
} from "@signalbox/runner-protocol/RunnerCommandProtocol";
import {
  RUNNER_HEARTBEAT_PING,
  RUNNER_HEARTBEAT_PONG,
  runnerFrame,
  threadFrame,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import type { MachineOwnershipAttestation } from "./Machine.ts";
import type { MachineProcessClosureAttestation } from "./MachineWorkspace.ts";
import type {
  MachineRunnerConnection,
  MachineRunnerOwner,
  MachineRunnerTransport,
} from "./RunnerMachineRuntime.ts";
import type { RunnerExecSocketHost } from "../thread/ThreadExecForwarder.ts";
import {
  assertCommandRunnerHello,
  captureCommandRunnerOwner,
  commandRunnerIdentity,
} from "./runner/CommandRunnerIdentity.ts";

export interface RunnerMachineSocketsOptions {
  readonly endpoint: string;
  readonly threadId: ThreadId;
  /** Writes the hydration owner's receipt before starting the command-only artifact. */
  readonly launch: (config: RunnerCommandConfig, signal: AbortSignal) => Promise<void>;
  /** Runs outside the command cgroup and verifies native descendants cannot write again. */
  readonly quiesce: (
    owner: MachineRunnerOwner,
    signal: AbortSignal,
  ) => Promise<MachineProcessClosureAttestation>;
  readonly workspaceReceipt: string;
  readonly cgroupPath?: (owner: MachineRunnerOwner) => string;
  readonly handshakeTimeoutMs?: number;
}

interface Registration {
  readonly owner: MachineOwnershipAttestation;
  readonly token: string;
  readonly socketHost: RunnerExecSocketHost;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  socket: WebSocket | null;
  admissionClosed: boolean;
  providerClosed: boolean;
  leased: boolean;
}

/** One accepted, command-only socket per fresh VM operation. Socket loss never attests closure. */
export class RunnerMachineSockets implements MachineRunnerTransport {
  readonly #options: RunnerMachineSocketsOptions;
  readonly #registrations = new Map<string, Registration>();
  readonly #tokens = new Map<string, Registration>();
  readonly #sockets = new Map<WebSocket, Registration | null>();

  constructor(options: RunnerMachineSocketsOptions) {
    const timeout = options.handshakeTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 4_294_967_295)
      throw new Error("Invalid command Runner handshake timeout");
    const endpoint = new URL(options.endpoint);
    if (
      !["ws:", "wss:"].includes(endpoint.protocol) ||
      endpoint.pathname !== COMMAND_RUNNER_CONNECT_PATH ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Invalid command Runner endpoint");
    this.#options = Object.freeze({ ...options });
  }

  readonly connect: MachineRunnerTransport["connect"] = async (input) => {
    input.signal.throwIfAborted();
    const owner = captureCommandRunnerOwner(input);
    const key = commandRunnerIdentity(owner);
    if (this.#registrations.has(key)) throw new Error("Command Runner is already registered");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // A launch can fail before connect starts awaiting the matching hello.
    void ready.catch(() => undefined);
    const registration: Registration = {
      owner,
      token: crypto.randomUUID() + crypto.randomUUID(),
      socketHost: input.socketHost,
      resolve,
      reject,
      socket: null,
      admissionClosed: false,
      providerClosed: false,
      leased: false,
    };
    this.#registrations.set(key, registration);
    this.#tokens.set(registration.token, registration);
    const deadline = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.#options.handshakeTimeoutMs ?? 30_000),
    ]);
    const aborted = () => {
      registration.admissionClosed = true;
      this.#tokens.delete(registration.token);
      this.#disconnect(registration);
      registration.reject(new Error("Command Runner connection cancelled"));
    };
    deadline.addEventListener("abort", aborted, { once: true });
    try {
      const cgroupPath = this.#options.cgroupPath?.(input);
      const config = RunnerCommandConfigJson.decode(
        RunnerCommandConfigJson.encode({
          version: 1,
          endpoint: this.#options.endpoint,
          threadId: this.#options.threadId,
          ...owner,
          token: registration.token,
          workspaceReceipt: this.#options.workspaceReceipt,
          ...(cgroupPath === undefined ? {} : { cgroupPath }),
        }),
      );
      await this.#options.launch(config, deadline);
      deadline.throwIfAborted();
      await ready;
      deadline.throwIfAborted();
      if (registration.admissionClosed || !registration.socket)
        throw new Error("Command Runner closed during bootstrap");
      return this.#connection(registration);
    } catch (error) {
      registration.admissionClosed = true;
      this.#tokens.delete(registration.token);
      this.#disconnect(registration);
      throw error;
    } finally {
      deadline.removeEventListener("abort", aborted);
    }
  };

  readonly quiesce: MachineRunnerTransport["quiesce"] = async (input) => {
    const owner = captureCommandRunnerOwner(input);
    const registration = this.#registrations.get(commandRunnerIdentity(owner));
    if (registration) {
      registration.admissionClosed = true;
      registration.reject(new Error("Command Runner is quiescing"));
    }
    const closure = await this.#options.quiesce(input, input.signal);
    if (
      commandRunnerIdentity(closure) !== commandRunnerIdentity(owner) ||
      closure.closed !== true
    ) {
      throw new Error("Command Runner closure belongs to another operation");
    }
    if (registration) {
      registration.providerClosed = true;
      this.#tokens.delete(registration.token);
      this.#registrations.delete(commandRunnerIdentity(owner));
    }
    return Object.freeze({ ...owner, closed: true });
  };

  /** The owning DO routes only this dedicated upgrade path here. Uses standard, nonhibernating sockets. */
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== COMMAND_RUNNER_CONNECT_PATH)
      return new Response(null, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Accepts a server socket; the first frame must authenticate an outstanding registration. */
  accept(socket: WebSocket) {
    if (this.#sockets.size >= 32) {
      socket.close(1008, "Command Runner socket capacity reached");
      return;
    }
    this.#sockets.set(socket, null);
    socket.accept();
    socket.addEventListener("message", (event) => this.message(socket, event.data));
    socket.addEventListener("close", () => this.closed(socket));
    socket.addEventListener("error", () => this.closed(socket));
  }

  message(socket: WebSocket, data: string | ArrayBuffer) {
    if (!this.#sockets.has(socket)) return;
    try {
      if (data === RUNNER_HEARTBEAT_PING && this.#sockets.get(socket)) {
        socket.send(RUNNER_HEARTBEAT_PONG);
        return;
      }
      const message = runnerFrame.decode(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      const current = this.#sockets.get(socket);
      if (!current) {
        if (message.type !== "hello") throw new Error("Command Runner must say hello first");
        const registration = this.#tokens.get(message.token);
        if (!registration || registration.socket || registration.admissionClosed)
          throw new Error("Command Runner is not registered");
        assertCommandRunnerHello(message, this.#options.threadId, registration.owner);
        this.#tokens.delete(registration.token);
        registration.socket = socket;
        this.#sockets.set(socket, registration);
        registration.socketHost.connected(socket, {
          generation: registration.owner.generation,
          connection: 1,
          protocolVersion: message.protocolVersion,
          exec: true,
          send: (frame) => {
            if (registration.admissionClosed && frame.command.type === "start")
              throw new Error("Command Runner admission is closed");
            if (registration.socket !== socket || socket.readyState !== WebSocket.OPEN)
              throw new Error("Command Runner socket is closed");
            socket.send(threadFrame.encode(frame));
          },
        });
        socket.send(
          threadFrame.encode({
            type: "welcome",
            generation: registration.owner.generation,
            ackedSequence: 0,
            activeRunId: null,
          }),
        );
        registration.resolve();
        return;
      }
      if (
        message.type === "exec.report" &&
        message.report.generation === current.owner.generation
      ) {
        current.socketHost.report(socket, current.owner.generation, 1, message.report);
        return;
      }
      if (message.type === "end") {
        this.closed(socket);
        return;
      }
      throw new Error("Unexpected command Runner frame");
    } catch {
      socket.close(1008, "Command Runner frame rejected");
      this.closed(socket);
    }
  }

  closed(socket: WebSocket) {
    const registration = this.#sockets.get(socket);
    this.#sockets.delete(socket);
    if (!registration || registration.socket !== socket) return;
    registration.admissionClosed = true;
    registration.socket = null;
    registration.reject(new Error("Command Runner socket closed"));
    registration.socketHost.disconnected(socket, registration.owner.generation, 1);
  }

  #connection(registration: Registration): MachineRunnerConnection {
    return {
      owner: registration.owner,
      lease: {
        acquire: async (signal) => {
          signal.throwIfAborted();
          if (registration.admissionClosed || registration.leased || !registration.socket)
            throw new Error("Command Runner lease is unavailable");
          registration.leased = true;
          let released = false;
          return {
            generation: registration.owner.generation,
            connection: 1,
            release: async () => {
              if (released) return;
              released = true;
              registration.leased = false;
            },
          };
        },
      },
      dispose: async () => {
        if (!registration.providerClosed || registration.leased)
          throw new Error("Command Runner ownership is still live");
        this.#tokens.delete(registration.token);
        this.#disconnect(registration);
        this.#registrations.delete(commandRunnerIdentity(registration.owner));
      },
    };
  }

  #disconnect(registration: Registration) {
    const socket = registration.socket;
    if (!socket) return;
    try {
      socket.close(1000, "Command Runner detached");
    } finally {
      this.closed(socket);
    }
  }
}
