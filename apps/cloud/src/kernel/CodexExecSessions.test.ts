import { describe, expect, it, vi } from "vitest";
import { CodexExecSessions, type ExecSessionHandler } from "./CodexExecSessions.ts";
import type { Notification, Reply } from "./CodexExecProtocol.ts";

const environmentInfo = { shell: { name: "sh", path: "/bin/sh" }, executorVersion: "0.0.0" };
const frame = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });

function setup() {
  const created: { signal: AbortSignal; notify: (message: Notification) => Promise<void> }[] = [];
  const request = vi.fn<ExecSessionHandler["request"]>().mockResolvedValue({ dispatched: true });
  const dispose = vi.fn<ExecSessionHandler["dispose"]>().mockResolvedValue(undefined);
  const onCleanupError = vi.fn();
  const sessions = new CodexExecSessions({
    environmentInfo,
    createSession: (context) => {
      created.push(context);
      return { request, dispose };
    },
    onCleanupError,
  });
  const messages: (Notification | Reply)[] = [];
  const connection = sessions.connect((message) => {
    messages.push(message);
  });
  const initialize = async (resumeSessionId?: string) => {
    await connection.receive(frame(1, "initialize", { clientName: "codex", resumeSessionId }));
    const reply = messages.at(-1);
    if (!reply || !("result" in reply)) throw new Error("Initialization failed");
    const result = reply.result as { sessionId: string; environmentInfo: typeof environmentInfo };
    await connection.receive('{"method":"initialized"}');
    return result.sessionId;
  };
  return { sessions, connection, messages, initialize, created, request, dispose, onCleanupError };
}

describe("Codex exec-server sessions", () => {
  it("requires both handshake messages before dispatch and returns honest environment metadata", async () => {
    const fixture = setup();
    try {
      await fixture.connection.receive(frame(0, "process/start", {}));
      expect(fixture.messages.at(-1)).toMatchObject({ id: 0, error: { code: -32600 } });
      expect(fixture.request).not.toHaveBeenCalled();
      await fixture.connection.receive(frame(1, "initialize", { clientName: "codex" }));
      expect(fixture.messages.at(-1)).toMatchObject({ id: 1, result: { environmentInfo } });
      await fixture.connection.receive(frame(2, "environment/status"));
      expect(fixture.messages.at(-1)).toMatchObject({ error: { code: -32600 } });
      await fixture.connection.receive('{"method":"initialized"}');
      await fixture.connection.receive(frame(3, "environment/status"));
      expect(fixture.messages.at(-1)).toEqual({ id: 3, result: { status: "ready" } });
      await fixture.connection.receive(frame(4, "process/read", { processId: "p" }));
      expect(fixture.request).toHaveBeenCalledWith(
        "process/read",
        { processId: "p" },
        expect.any(AbortSignal),
      );
    } finally {
      await fixture.sessions.dispose();
    }
  });

  it("retains the same process handler across disconnect and resume and permits only one attachment", async () => {
    const fixture = setup();
    try {
      const id = await fixture.initialize();
      const otherMessages: (Reply | Notification)[] = [];
      const other = fixture.sessions.connect((message) => {
        otherMessages.push(message);
      });
      await other.receive(frame(1, "initialize", { clientName: "codex", resumeSessionId: id }));
      expect(otherMessages.at(-1)).toMatchObject({ error: { code: -32010 } });
      fixture.connection.disconnect();
      expect(fixture.dispose).not.toHaveBeenCalled();
      expect(fixture.created[0]!.signal.aborted).toBe(false);
      await other.receive(frame(2, "initialize", { clientName: "codex", resumeSessionId: id }));
      expect(otherMessages.at(-1)).toMatchObject({ result: { sessionId: id } });
      await other.receive('{"method":"initialized"}');
      await fixture.created[0]!.notify({ method: "process/output", params: { seq: 1 } });
      expect(otherMessages.at(-1)).toMatchObject({ method: "process/output" });
      expect(fixture.created).toHaveLength(1);
    } finally {
      await fixture.sessions.dispose();
    }
  });

  it("expires detached sessions and releases their processes without polling", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    try {
      const id = await fixture.initialize();
      fixture.connection.disconnect();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.created[0]!.signal.aborted).toBe(true);
      expect(fixture.dispose).toHaveBeenCalledOnce();
      const replies: (Reply | Notification)[] = [];
      const replacement = fixture.sessions.connect((message) => {
        replies.push(message);
      });
      await replacement.receive(
        frame(1, "initialize", { clientName: "codex", resumeSessionId: id }),
      );
      expect(replies.at(-1)).toMatchObject({ error: { code: -32600 } });
    } finally {
      await fixture.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels in-flight connection work on disconnect but retains session ownership", async () => {
    const fixture = setup();
    try {
      await fixture.initialize();
      let entered!: (signal: AbortSignal) => void;
      const ready = new Promise<AbortSignal>((resolve) => {
        entered = resolve;
      });
      fixture.request.mockImplementationOnce(async (_method, _params, signal) => {
        entered(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      });
      const read = fixture.connection.receive(
        frame(2, "process/read", { processId: "p", waitMs: 60_000 }),
      );
      const signal = await ready;
      fixture.connection.disconnect();
      await read;
      expect(signal.aborted).toBe(true);
      expect(fixture.created[0]!.signal.aborted).toBe(false);
      expect(fixture.messages).toHaveLength(1);
    } finally {
      await fixture.sessions.dispose();
    }
  });

  it("uses upstream malformed-request ids and rejects repeated initialization", async () => {
    const fixture = setup();
    try {
      await fixture.connection.receive("[");
      expect(fixture.messages.at(-1)).toMatchObject({ id: -1, error: { code: -32600 } });
      await fixture.initialize();
      await fixture.connection.receive(frame(2, "initialize", { clientName: "codex" }));
      expect(fixture.messages.at(-1)).toMatchObject({ id: 2, error: { code: -32600 } });
    } finally {
      await fixture.sessions.dispose();
    }
  });

  it("keeps failed cleanup owned until a successful retry and refuses replacement admission", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    try {
      await fixture.initialize();
      fixture.dispose.mockRejectedValueOnce(new Error("Child rejected termination"));
      fixture.connection.disconnect();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.onCleanupError).toHaveBeenCalledOnce();
      const replies: (Reply | Notification)[] = [];
      const replacement = fixture.sessions.connect((message) => {
        replies.push(message);
      });
      await replacement.receive(frame(1, "initialize", { clientName: "codex" }));
      expect(replies.at(-1)).toMatchObject({ error: { code: -32603 } });
      expect(fixture.created).toHaveLength(1);
      await fixture.sessions.dispose();
      expect(fixture.dispose).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("closes unattached transports during server disposal", async () => {
    const fixture = setup();
    const close = vi.fn();
    const uninitialized = fixture.sessions.connect(() => undefined, close);
    await fixture.sessions.dispose();
    expect(uninitialized.closed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
