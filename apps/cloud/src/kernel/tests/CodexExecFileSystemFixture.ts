import * as NodeBuffer from "node:buffer";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { CodexExecHandler } from "../CodexExecHandler.ts";
import { CodexExecSessions } from "../CodexExecSessions.ts";
import type { Reply } from "../CodexExecProtocol.ts";
import { KernelFileSystem, KernelOpenFlags } from "../KernelFileSystem.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const frame = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });

export async function codexFilesystemFixture() {
  const database = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, now) }],
  });
  const messages: Array<Reply | { method: string; params: unknown }> = [];
  const sessions = new CodexExecSessions({
    environmentInfo: {
      shell: { name: "sh", path: "/bin/sh" },
      executorVersion: "test",
    },
    createSession: ({ signal: sessionSignal, notify }) =>
      new CodexExecHandler({
        filesystem,
        spawn: async () => {
          throw new Error("A filesystem test must not start a process");
        },
        baseEnv: {},
        sessionSignal,
        notify,
      }),
    onCleanupError: () => {},
  });
  const connection = sessions.connect((message) => {
    messages.push(message);
  });
  await connection.receive(frame(1, "initialize", { clientName: "filesystem test" }));
  await connection.receive('{"method":"initialized"}');
  let nextId = 2;

  return {
    database,
    filesystem,
    sessions,
    async request(method: string, params?: unknown): Promise<Reply> {
      const id = nextId++;
      const before = messages.length;
      await connection.receive(frame(id, method, params));
      const response = messages
        .slice(before)
        .find((message) => "id" in message && message.id === id);
      if (!response || !("id" in response)) throw new Error(`Missing reply for ${method}`);
      return response;
    },
    async close() {
      await sessions.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}

export function readKernelFile(filesystem: KernelFileSystem, path: string): string {
  const descriptor = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const content = NodeBuffer.Buffer.alloc(Number(filesystem.fstat(descriptor).size));
    let offset = 0;
    while (offset < content.byteLength) {
      const count = filesystem.read(descriptor, content.subarray(offset), null);
      if (count === 0) break;
      offset += count;
    }
    return content.subarray(0, offset).toString("utf8");
  } finally {
    filesystem.close(descriptor);
  }
}
