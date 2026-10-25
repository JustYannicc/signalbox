import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { CodexExecFileSystem } from "./CodexExecFileSystem.ts";
import { CodexExecHandler } from "./CodexExecHandler.ts";
import { CodexExecSessions } from "./CodexExecSessions.ts";
import type { Reply } from "./CodexExecProtocol.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (value: string) => new TextEncoder().encode(value);
const base64 = (value: string | Uint8Array) => NodeBuffer.Buffer.from(value).toString("base64");
const frame = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });

describe("Codex exec-server filesystem", () => {
  it("serves shared, persistent filesystem RPCs through the real exec session", async () => {
    const test = await fixture();
    const path = "/work/nested/notes.txt";
    const uri = "file:///work/nested/notes.txt";
    try {
      expect(await test.request("fs/getMetadata", { path: uri })).toMatchObject({
        error: { code: -32004 },
      });
      expect(await test.request("fs/readFile", { path: uri })).toMatchObject({
        error: { code: -32004 },
      });

      expect(
        await test.request("fs/writeFile", {
          path: uri,
          dataBase64: base64("from real patch\n"),
        }),
      ).toMatchObject({ error: { code: -32004 } });

      expect(
        await test.request("fs/createDirectory", { path: "file:///work/nested" }),
      ).toMatchObject({ result: {} });
      expect(
        await test.request("fs/createDirectory", { path: "file:///work/nested" }),
      ).toMatchObject({ result: {} });
      expect(
        await test.request("fs/writeFile", {
          path: uri,
          dataBase64: base64("from real patch\n"),
        }),
      ).toMatchObject({ result: {} });
      expect(await test.request("fs/readFile", { path: uri })).toMatchObject({
        result: { dataBase64: base64("from real patch\n") },
      });

      expect(await test.request("fs/getMetadata", { path: uri })).toMatchObject({
        result: {
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          size: bytes("from real patch\n").byteLength,
          createdAtMs: 0,
          modifiedAtMs: 1_800_000_000_000,
        },
      });
      expect(await test.request("fs/canonicalize", { path: uri })).toEqual({
        id: expect.any(Number),
        result: { path: uri },
      });

      // The composed handler still sends process calls to its process adapter.
      expect(await test.request("process/terminate", { processId: "no-process" })).toMatchObject({
        result: { running: false },
      });
      expect(await test.request("fs/unsupported", { path: uri })).toMatchObject({
        error: { code: -32601 },
      });

      await test.sessions.dispose();
      expect(readKernelFile(test.filesystem, path)).toBe("from real patch\n");

      const reopened = new KernelFileSystem({
        mounts: [{ path: "/", storage: createFacetSqliteStorage(test.database.storage, now) }],
      });
      try {
        expect(readKernelFile(reopened, path)).toBe("from real patch\n");
      } finally {
        reopened.dispose();
      }
    } finally {
      await test.close();
    }
  });

  it("round-trips binary bytes and truncates an existing file on replacement", async () => {
    const test = await fixture();
    const path = "file:///binary.dat";
    const content = Uint8Array.from([0, 255, 128, 65, 0]);
    try {
      expect(
        await test.request("fs/writeFile", { path, dataBase64: base64("longer old data") }),
      ).toMatchObject({
        result: {},
      });
      expect(
        await test.request("fs/writeFile", { path, dataBase64: base64(content) }),
      ).toMatchObject({
        result: {},
      });
      expect(await test.request("fs/readFile", { path })).toMatchObject({
        result: { dataBase64: base64(content) },
      });
      expect(test.filesystem.stat("/binary.dat").size).toBe(BigInt(content.byteLength));
    } finally {
      await test.close();
    }
  });

  it("canonicalizes encoded paths and follows links only when requested", async () => {
    const test = await fixture();
    const targetPath = "/work/mañana notes.txt";
    const targetUri = "file:///work/ma%C3%B1ana%20notes.txt";
    try {
      expect(await test.request("fs/createDirectory", { path: "file:///work" })).toMatchObject({
        result: {},
      });
      expect(
        await test.request("fs/writeFile", {
          path: targetUri,
          dataBase64: base64("target"),
        }),
      ).toMatchObject({ result: {} });
      test.filesystem.symlink("mañana notes.txt", "/work/latest");

      expect(await test.request("fs/readFile", { path: "file:///work/latest" })).toMatchObject({
        result: { dataBase64: base64("target") },
      });
      expect(
        await test.request("fs/readFile", {
          path: "file:///work/latest",
          followSymlinks: false,
        }),
      ).toMatchObject({ error: { code: -32600 } });
      expect(await test.request("fs/canonicalize", { path: "file:///work/latest" })).toMatchObject({
        result: { path: targetUri },
      });
      expect(await test.request("fs/getMetadata", { path: "file:///work/latest" })).toMatchObject({
        result: { isFile: true, isDirectory: false, isSymlink: true },
      });
      expect(await test.request("fs/getMetadata", { path: targetUri })).toMatchObject({
        result: { isFile: true, isDirectory: false, isSymlink: false },
      });
      expect(test.filesystem.realpath(targetPath)).toBe(targetPath);
    } finally {
      await test.close();
    }
  });

  it("rejects virtual descriptor links without following them", async () => {
    const test = await fixture();
    const original = "keep the descriptor target";
    let descriptor: number | undefined;
    try {
      await test.request("fs/writeFile", {
        path: "file:///descriptor-target.txt",
        dataBase64: base64(original),
      });
      descriptor = test.filesystem.open("/descriptor-target.txt", KernelOpenFlags.O_RDWR);
      expect(() => test.filesystem.lstat("/proc")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      const path = `file:///proc/self/fd/${descriptor}`;
      expect(await test.request("fs/readFile", { path })).toMatchObject({
        result: { dataBase64: base64(original) },
      });
      for (const method of ["fs/readFile", "fs/writeFile", "fs/getMetadata"]) {
        expect(
          await test.request(method, {
            path,
            followSymlinks: false,
            dataBase64: base64("must not replace the target"),
          }),
          method,
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(readKernelFile(test.filesystem, "/descriptor-target.txt")).toBe(original);
    } finally {
      if (descriptor !== undefined) test.filesystem.close(descriptor);
      await test.close();
    }
  });

  it("rejects malformed file URIs, sandbox requests, and invalid base64 before changing data", async () => {
    const test = await fixture();
    const path = "file:///keep.txt";
    const original = "keep this content";
    try {
      await test.request("fs/writeFile", { path, dataBase64: base64(original) });
      expect(await test.request("fs/writeFile", { path, dataBase64: "YR==" })).toMatchObject({
        error: { code: -32600 },
      });
      expect(await test.request("fs/writeFile", { path, dataBase64: "%%%" })).toMatchObject({
        error: { code: -32600 },
      });
      expect(
        await test.request("fs/writeFile", { path, dataBase64: base64("changed"), sandbox: {} }),
      ).toMatchObject({ error: { code: -32600 } });
      expect(
        await test.request("fs/writeFile", { path: 4, dataBase64: base64("changed") }),
      ).toMatchObject({
        error: { code: -32602 },
      });

      for (const invalidPath of [
        "file://remote/work/file",
        "file:///work/file?query=1",
        "file:///work/file#fragment",
        "file:///work/a%2Fb",
        "file:///work/a%5Cb",
        "file:///work/a\\b",
        "file:///work/%00file",
      ]) {
        expect(await test.request("fs/readFile", { path: invalidPath }), invalidPath).toMatchObject(
          { error: { code: -32602 } },
        );
      }

      expect(await test.request("fs/readFile", { path })).toMatchObject({
        result: { dataBase64: base64(original) },
      });
      expect(
        await test.request("fs/getMetadata", { path: "file:///must-not-exist" }),
      ).toMatchObject({
        error: { code: -32004 },
      });
    } finally {
      await test.close();
    }
  });

  it("rejects canceled and over-limit whole-file writes without creating a file", async () => {
    const test = await fixture();
    const files = new CodexExecFileSystem({ filesystem: test.filesystem });
    const path = "file:///never-created";
    const signal = new AbortController();
    signal.abort();
    try {
      await expect(
        files.request("fs/writeFile", { path, dataBase64: base64("cancelled") }, signal.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        files.request(
          "fs/writeFile",
          { path, dataBase64: NodeBuffer.Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(
        files.request("fs/getMetadata", { path }, new AbortController().signal),
      ).rejects.toMatchObject({
        code: -32004,
      });
    } finally {
      await test.close();
    }
  });

  it("maps read-only filesystem writes to invalid request errors", async () => {
    const database = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: createFacetSqliteStorage(database.storage, now), readOnly: true },
      ],
    });
    const files = new CodexExecFileSystem({ filesystem });
    try {
      await expect(
        files.request(
          "fs/writeFile",
          { path: "file:///read-only", dataBase64: base64("blocked") },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: -32600 });
      expect(() => filesystem.stat("/read-only")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await files.dispose();
      filesystem.dispose();
      database.close();
    }
  });
});

async function fixture() {
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

function readKernelFile(filesystem: KernelFileSystem, path: string): string {
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
