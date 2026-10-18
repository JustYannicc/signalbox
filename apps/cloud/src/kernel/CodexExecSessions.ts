// @effect-diagnostics cryptoRandomUUID:off globalTimers:off - connection-owned protocol sessions do not require an Effect runtime.
import {
  decodeMessage,
  initializeParams,
  invalidRequest,
  RpcError,
  type EnvironmentInfo,
  type Message,
  type Notification,
  type Reply,
} from "./CodexExecProtocol.ts";

export interface ExecSessionHandler {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  dispose(): Promise<void>;
}

type Send = (message: Reply | Notification) => void | Promise<void>;
type Session = {
  readonly id: string;
  readonly abort: AbortController;
  readonly handler: ExecSessionHandler;
  send: Send | undefined;
  connection: object | undefined;
  disconnect: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: Promise<void> | undefined;
};

interface SessionOptions {
  readonly environmentInfo: EnvironmentInfo;
  readonly createSession: (context: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly notify: (message: Notification) => Promise<void>;
  }) => ExecSessionHandler;
  readonly onCleanupError: (error: unknown) => void;
  readonly maxSessions?: number;
  readonly detachedTtlMs?: number;
}

/** Exec-server reconnects retain process output and write identities in their owning session. */
export class CodexExecSessions {
  readonly #options: SessionOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #connections = new Set<() => void>();
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  #closed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#maxSessions = options.maxSessions ?? 1;
    this.#ttlMs = options.detachedTtlMs ?? 30_000;
    for (const [name, value] of [
      ["maxSessions", this.#maxSessions],
      ["detachedTtlMs", this.#ttlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`${name} must be a positive platform integer`);
      }
    }
  }

  connect(send: Send, closeTransport?: () => void) {
    if (this.#closed) throw new RpcError(-32600, "Exec-server is closed");
    const identity = {};
    const abort = new AbortController();
    let session: Session | undefined;
    let initialized = false;
    let initializeRequested = false;
    let closed = false;
    const disconnect = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      this.#connections.delete(disconnect);
      if (session?.connection === identity) {
        session.connection = undefined;
        session.disconnect = undefined;
        session.send = undefined;
        if (!this.#closed) {
          const detached = session;
          detached.timer = setTimeout(() => {
            void this.#remove(detached).catch(this.#options.onCleanupError);
          }, this.#ttlMs);
        }
      }
      closeTransport?.();
    };
    const sendIfOpen: Send = async (message) => {
      if (closed) return;
      try {
        await send(message);
      } catch (error) {
        disconnect();
        throw error;
      }
    };
    const request = async (message: Message) => {
      if (message.method === "initialize") {
        if (initializeRequested)
          return invalidRequest("initialize may only be sent once per connection");
        initializeRequested = true;
        try {
          const params = initializeParams(message.params);
          session = this.#attach(params.resumeSessionId, identity, sendIfOpen, disconnect);
          return { sessionId: session.id, environmentInfo: this.#options.environmentInfo };
        } catch (error) {
          initializeRequested = false;
          throw error;
        }
      }
      if (!session || !initialized)
        return invalidRequest("Client must initialize and send initialized before using methods");
      if (message.method === "environment/info") return this.#options.environmentInfo;
      if (message.method === "environment/status") return { status: "ready" };
      return session.handler.request(message.method, message.params, abort.signal);
    };

    this.#connections.add(disconnect);
    return {
      get closed() {
        return closed;
      },
      disconnect,
      receive: async (text: string): Promise<void> => {
        if (closed || this.#closed) return;
        let message: Message;
        try {
          message = decodeMessage(text);
        } catch (error) {
          await sendIfOpen({ id: -1, error: rpcError(error) });
          return;
        }
        if (message.id === undefined) {
          if (message.method === "initialized" && session) initialized = true;
          else disconnect();
          return;
        }
        let reply: Reply;
        try {
          reply = { id: message.id, result: await request(message) };
        } catch (error) {
          reply = { id: message.id, error: rpcError(error) };
        }
        await sendIfOpen(reply);
      },
    };
  }

  async dispose() {
    this.#closed = true;
    for (const disconnect of this.#connections) disconnect();
    const results = await Promise.allSettled(
      [...this.#sessions.values()].map((session) => this.#remove(session)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "Exec-server session cleanup failed");
  }

  #attach(
    resumeId: string | undefined,
    connection: object,
    send: Send,
    disconnect: () => void,
  ): Session {
    if (this.#closed) return invalidRequest("Exec-server is closed");
    let session: Session;
    if (resumeId !== undefined) {
      const existing = this.#sessions.get(resumeId);
      if (!existing) return invalidRequest("Unknown session id");
      if (existing.abort.signal.aborted) return invalidRequest("Session is closed");
      if (existing.connection)
        throw new RpcError(-32010, "Session is already attached to another connection");
      session = existing;
      clearTimeout(session.timer);
      session.timer = undefined;
    } else {
      if (this.#sessions.size >= this.#maxSessions)
        throw new RpcError(-32603, "Too many exec-server sessions");
      const id = crypto.randomUUID();
      const abort = new AbortController();
      const created: Session = {
        id,
        abort,
        handler: this.#options.createSession({
          sessionId: id,
          signal: abort.signal,
          notify: async (message) => {
            try {
              await this.#sessions.get(id)?.send?.(message);
            } catch {
              /* Detached output is recovered through process/read after resume. */
            }
          },
        }),
        connection: undefined,
        disconnect: undefined,
        send: undefined,
        timer: undefined,
        cleanup: undefined,
      };
      session = created;
      this.#sessions.set(id, session);
    }
    session.connection = connection;
    session.disconnect = disconnect;
    session.send = send;
    return session;
  }

  async #remove(session: Session) {
    if (this.#sessions.get(session.id) !== session) return;
    if (session.cleanup) return session.cleanup;
    clearTimeout(session.timer);
    session.send = undefined;
    session.connection = undefined;
    session.disconnect?.();
    session.disconnect = undefined;
    session.abort.abort();
    const cleanup = Promise.resolve()
      .then(() => session.handler.dispose())
      .then(() => {
        this.#sessions.delete(session.id);
      })
      .finally(() => {
        session.cleanup = undefined;
      });
    session.cleanup = cleanup;
    // Failed cleanup keeps its admission slot so a replacement cannot abandon a live child.
    await cleanup;
  }
}

function rpcError(error: unknown) {
  return error instanceof RpcError
    ? { code: error.code, message: error.message }
    : { code: -32603, message: "Exec-server operation failed" };
}
