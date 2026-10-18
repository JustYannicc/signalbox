// @effect-diagnostics preferSchemaOverJson:off - the proof exercises the native exec-server wire boundary.
import { CodexExecOutputLog } from "./CodexExecOutputLog.ts";
import {
  decodeMessage,
  encodeMessage,
  object,
  RpcError,
  startParams,
} from "./CodexExecProtocol.ts";
import { CodexExecSessions } from "./CodexExecSessions.ts";
import { acceptCodexExecWebSocket } from "./CodexExecWebSocket.ts";

export async function runCodexExecProtocolProof(lifetime: Pick<DurableObjectState, "waitUntil">) {
  const checks: string[] = [];
  const check = (condition: boolean, name: string) => {
    if (!condition) throw new Error(`Exec-server proof failed: ${name}`);
    checks.push(name);
  };
  const decoded = decodeMessage(
    '{"id":"codex-1","method":"process/read","params":{"processId":"p"}}',
  );
  check(decoded.id === "codex-1" && decoded.method === "process/read", "Codex JSON-RPC dialect");
  const exactId = decodeMessage('{"id":9223372036854775807,"method":"initialize"}').id;
  check(
    exactId === 9223372036854775807n &&
      encodeMessage({ id: exactId, result: {} }) === '{"id":9223372036854775807,"result":{}}',
    "Exact signed 64-bit request identity",
  );
  const launch = startParams({
    processId: "not-a-pid",
    argv: ["/bin/echo", "", "a b"],
    cwd: "file:///workspace/a%20b",
    env: { EMPTY: "" },
    tty: false,
  });
  check(
    launch.argv[1] === "" && launch.cwd === "file:///workspace/a%20b",
    "Unchanged argv and path URI",
  );

  const log = new CodexExecOutputLog({ maxBytes: 4, maxChunkBytes: 4 });
  const waiting = log.read({ waitMs: 10_000 });
  const first = log.append("stdout", Uint8Array.of(0, 255));
  check((await waiting).chunks[0]?.chunk === "AP8=", "Read wake and binary output");
  const exit = log.exited(17);
  const tail = log.append("stderr", Uint8Array.of(42));
  const close = log.close();
  check(
    first.seq === 1 && exit.seq === 2 && tail.seq === 3 && close.seq === 4,
    "Output, exit and EOF sequence",
  );
  const page = await log.read({ maxBytes: 1 });
  check(page.chunks.length === 1 && page.nextSeq === 2, "Byte-budget replay cursor");
  const replay = await log.read({ afterSeq: 1 });
  check(
    replay.chunks[0]?.seq === 3 && replay.exitCode === 17 && replay.closed && replay.nextSeq === 5,
    "Tail output survives exit",
  );
  log.dispose();

  let created = 0;
  let disposed = 0;
  const cleanupErrors: unknown[] = [];
  const sessions = new CodexExecSessions({
    environmentInfo: {
      shell: { name: "sh", path: "/bin/sh" },
      executorVersion: "0.0.0",
      capabilities: {},
    },
    createSession: () => {
      created++;
      return {
        request: async () => {
          throw new RpcError(-32601, "Method is not implemented by the protocol fixture");
        },
        dispose: async () => {
          disposed++;
        },
      };
    },
    onCleanupError: (error) => {
      cleanupErrors.push(error);
    },
  });
  const clients: ProofClient[] = [];
  const connect = () => {
    const response = acceptCodexExecWebSocket(
      new Request("https://kernel.invalid/exec", { headers: { Upgrade: "websocket" } }),
      sessions,
      lifetime,
    );
    check(response.status === 101, "Native WebSocket upgrade");
    if (!response.webSocket) throw new Error("No client WebSocket");
    const client = new ProofClient(response.webSocket);
    clients.push(client);
    return client;
  };
  try {
    check(
      acceptCodexExecWebSocket(new Request("https://kernel.invalid/exec"), sessions, lifetime)
        .status === 426,
      "Non-upgrade rejected",
    );
    const firstClient = connect();
    check(
      object((await firstClient.call("environment/status")).error).code === -32600,
      "Handshake required",
    );
    const initialized = object(
      (await firstClient.call("initialize", { clientName: "codex-proof" })).result,
    );
    const sessionId = initialized.sessionId;
    check(typeof sessionId === "string", "Session identity returned");
    firstClient.notify("initialized");
    check(
      object((await firstClient.call("environment/status", {}, true)).result).status === "ready",
      "Binary UTF-8 JSON frame",
    );
    check(
      object((await firstClient.call("fs/readFile", {})).error).code === -32601,
      "Unimplemented capabilities fail explicitly",
    );
    const competing = connect();
    check(
      object(
        (await competing.call("initialize", { clientName: "other", resumeSessionId: sessionId }))
          .error,
      ).code === -32010,
      "Single session attachment",
    );
    await firstClient.close();
    check(disposed === 0, "Disconnect retains session owner");
    const resumed = object(
      (
        await competing.call("initialize", {
          clientName: "codex-proof",
          resumeSessionId: sessionId,
        })
      ).result,
    );
    check(resumed.sessionId === sessionId && created === 1, "Resume reuses the same handler");
    competing.notify("initialized");
    check(
      object((await competing.call("environment/status")).result).status === "ready",
      "Resumed connection ready",
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await sessions.dispose();
  }
  check(disposed === 1 && cleanupErrors.length === 0, "Session cleanup completed");
  return { ok: true, checks };
}

class ProofClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
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
          for (const waiter of this.#pending.values())
            waiter.reject(new Error(`Proof WebSocket closed ${event.code}: ${event.reason}`));
          this.#pending.clear();
          resolve();
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      const value = object(
        JSON.parse(
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data),
        ),
      );
      if (typeof value.id !== "number") return;
      this.#pending.get(value.id)?.resolve(value);
      this.#pending.delete(value.id);
    });
    socket.accept();
  }

  call(method: string, params: unknown = {}, binary = false) {
    const id = ++this.#nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const text = JSON.stringify({ id, method, params });
      this.#socket.send(binary ? new TextEncoder().encode(text) : text);
    });
  }

  notify(method: string) {
    this.#socket.send(JSON.stringify({ method, params: {} }));
  }

  async close() {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1000, "Proof complete");
    await this.#closed;
  }
}
