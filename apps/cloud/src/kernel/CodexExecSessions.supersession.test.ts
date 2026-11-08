import { describe, expect, it, vi } from "vite-plus/test";
import { CodexExecSessions, type ExecSessionHandler } from "./CodexExecSessions.ts";
import type { Notification, Reply } from "./CodexExecProtocol.ts";

function fixture() {
  const created: { sessionId: string; signal: AbortSignal }[] = [];
  const dispose = vi.fn<ExecSessionHandler["dispose"]>().mockResolvedValue(undefined);
  const onCleanupError = vi.fn();
  const sessions = new CodexExecSessions({
    environmentInfo: { shell: { name: "sh", path: "/bin/sh" }, executorVersion: "test" },
    createSession: (context) => {
      created.push(context);
      return { request: async () => ({ dispatched: true }), dispose };
    },
    onCleanupError,
  });
  const peer = (owner?: object) => {
    const replies: (Reply | Notification)[] = [];
    const connection = sessions.connect(
      (reply) => {
        replies.push(reply);
      },
      undefined,
      owner,
    );
    return {
      connection,
      replies,
      initialize: (resumeSessionId: string | null = null) =>
        connection.receive(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientName: "codex", resumeSessionId },
          }),
        ),
    };
  };
  return { sessions, created, dispose, onCleanupError, peer };
}

describe("Codex process-owned exec session supersession", () => {
  it("awaits cleanup of its own detached session before admitting a fresh session", async () => {
    const f = fixture();
    const owner = {};
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      const first = f.peer(owner);
      await first.initialize();
      const old = f.created[0]!;
      first.connection.disconnect();
      f.dispose.mockImplementationOnce(() => {
        entered.resolve();
        return cleanup.promise;
      });
      const next = f.peer(owner);
      const initializing = next.initialize();
      await entered.promise;
      expect(old.signal.aborted).toBe(true);
      expect(next.replies).toEqual([]);
      expect(f.created).toHaveLength(1);
      cleanup.resolve();
      await initializing;
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.created).toHaveLength(2);
      expect(next.replies).toEqual([
        {
          id: 1,
          result: {
            sessionId: f.created[1]!.sessionId,
            environmentInfo: { shell: { name: "sh", path: "/bin/sh" }, executorVersion: "test" },
          },
        },
      ]);
      expect(f.created[1]!.sessionId).not.toBe(old.sessionId);
    } finally {
      cleanup.resolve();
      await f.sessions.dispose();
    }
  });

  it("keeps an attached session against capacity even for the same process", async () => {
    const f = fixture();
    const owner = {};
    try {
      await f.peer(owner).initialize();
      const next = f.peer(owner);
      await next.initialize();
      expect(next.replies).toMatchObject([{ error: { message: "Too many exec-server sessions" } }]);
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.created).toHaveLength(1);
    } finally {
      await f.sessions.dispose();
    }
  });

  it("does not let another process or an unowned connection evict or resume its retained session", async () => {
    const f = fixture();
    const owner = {};
    try {
      const first = f.peer(owner);
      await first.initialize();
      const old = f.created[0]!;
      first.connection.disconnect();
      for (const otherOwner of [{}, undefined]) {
        const next = f.peer(otherOwner);
        await next.initialize();
        expect(next.replies.at(-1)).toMatchObject({
          error: { message: "Too many exec-server sessions" },
        });
        await next.initialize(old.sessionId);
        expect(next.replies.at(-1)).toMatchObject({
          error: { message: "Session belongs to another process" },
        });
      }
      expect(old.signal.aborted).toBe(false);
      expect(f.dispose).not.toHaveBeenCalled();
      const resumed = f.peer(owner);
      await resumed.initialize(old.sessionId);
      expect(resumed.replies.at(-1)).toMatchObject({ result: { sessionId: old.sessionId } });
      expect(f.created).toHaveLength(1);
    } finally {
      await f.sessions.dispose();
    }
  });

  it("rejects loudly and keeps the admission slot when supersession cleanup fails", async () => {
    const f = fixture();
    const owner = {};
    try {
      const first = f.peer(owner);
      await first.initialize();
      first.connection.disconnect();
      const error = new Error("Child rejected termination");
      f.dispose.mockRejectedValueOnce(error);
      const next = f.peer(owner);
      await next.initialize();
      expect(next.replies).toMatchObject([
        {
          error: {
            code: -32603,
            message: "Exec-server session supersession cleanup failed",
          },
        },
      ]);
      expect(f.onCleanupError).toHaveBeenCalledWith(error);
      expect(f.created).toHaveLength(1);
      const outsider = f.peer({});
      await outsider.initialize();
      expect(outsider.replies.at(-1)).toMatchObject({
        error: { message: "Too many exec-server sessions" },
      });
      await f.sessions.dispose();
      expect(f.dispose).toHaveBeenCalledTimes(2);
    } finally {
      await f.sessions.dispose();
    }
  });

  it("admits only one concurrent replacement after shared cleanup", async () => {
    const f = fixture();
    const owner = {};
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      const first = f.peer(owner);
      await first.initialize();
      first.connection.disconnect();
      f.dispose.mockImplementationOnce(() => {
        entered.resolve();
        return cleanup.promise;
      });
      const next = [f.peer(owner), f.peer(owner)];
      const attempts = next.map((peer) => peer.initialize());
      await entered.promise;
      cleanup.resolve();
      await Promise.all(attempts);
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.created).toHaveLength(2);
      expect(
        next.flatMap((peer) => peer.replies).filter((reply) => "result" in reply),
      ).toHaveLength(1);
      expect(
        next.flatMap((peer) => peer.replies).filter((reply) => "error" in reply),
      ).toMatchObject([{ error: { message: "Too many exec-server sessions" } }]);
    } finally {
      cleanup.resolve();
      await f.sessions.dispose();
    }
  });

  it.each(["disconnect", "dispose"] as const)(
    "does not admit a replacement after %s during cleanup",
    async (action) => {
      const f = fixture();
      const owner = {};
      const cleanup = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      try {
        const first = f.peer(owner);
        await first.initialize();
        first.connection.disconnect();
        f.dispose.mockImplementationOnce(() => {
          entered.resolve();
          return cleanup.promise;
        });
        const next = f.peer(owner);
        const initializing = next.initialize();
        await entered.promise;
        const closing = action === "dispose" ? f.sessions.dispose() : next.connection.disconnect();
        cleanup.resolve();
        await Promise.all([initializing, closing]);
        expect(f.created).toHaveLength(1);
        expect(next.replies).toEqual([]);
      } finally {
        cleanup.resolve();
        await f.sessions.dispose();
      }
    },
  );

  it("detaches admission if its transport closes before the initialize reply", async () => {
    const f = fixture();
    const owner = {};
    try {
      const first = f.peer(owner);
      const initializing = first.initialize();
      first.connection.disconnect();
      await initializing;
      const next = f.peer(owner);
      await next.initialize();
      expect(next.replies.at(-1)).toMatchObject({ result: { sessionId: f.created[1]!.sessionId } });
      expect(f.dispose).toHaveBeenCalledOnce();
    } finally {
      await f.sessions.dispose();
    }
  });
});
