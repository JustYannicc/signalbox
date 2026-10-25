// @effect-diagnostics preferSchemaOverJson:off - the fixture observes the external Codex wire on native WebSockets.
import { object } from "../CodexExecProtocol.ts";

/** A fixture client that waits on protocol milestones instead of polling process state. */
export class ExecProofClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #notifications = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #closed: Promise<void>;
  #nextId = 0;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    this.#closed = new Promise((resolve) => {
      socket.addEventListener(
        "close",
        (event) => {
          const error = new Error(`Execution proof socket closed ${event.code}: ${event.reason}`);
          for (const pending of this.#pending.values()) pending.reject(error);
          for (const pending of this.#notifications.values()) pending.reject(error);
          this.#pending.clear();
          this.#notifications.clear();
          resolve();
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      const message = object(
        JSON.parse(
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data),
        ),
      );
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          const error = object(message.error);
          pending.reject(new Error(`Exec-server ${String(error.code)}: ${String(error.message)}`));
        } else pending.resolve(message.result);
        return;
      }
      const params = object(message.params);
      const key = `${String(message.method)}:${String(params.processId)}`;
      this.#notifications.get(key)?.resolve(params);
      this.#notifications.delete(key);
    });
    socket.accept();
  }

  call(method: string, params: unknown = {}) {
    const id = ++this.#nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string) {
    this.#socket.send(JSON.stringify({ method, params: {} }));
  }

  notification(method: string, processId: string) {
    const key = `${method}:${processId}`;
    if (this.#notifications.has(key)) throw new Error("Proof notification already has a waiter");
    const pending = new Promise<unknown>((resolve, reject) => {
      this.#notifications.set(key, { resolve, reject });
    });
    void pending.catch(() => undefined);
    return pending;
  }

  async close() {
    if (this.#socket.readyState === WebSocket.OPEN)
      this.#socket.close(1000, "Execution proof complete");
    await this.#closed;
  }
}
