import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { codexFilesystemFixture, readKernelFile } from "./tests/CodexExecFileSystemFixture.ts";

const base64 = (text: string) => NodeBuffer.Buffer.from(text).toString("base64");
const entry = (path: string, access: string) => ({
  path: { type: "path", path: `file://${path}` },
  access,
});
const restricted = (entries: readonly ReturnType<typeof entry>[]) => ({
  permissions: {
    type: "managed",
    file_system: { type: "restricted", entries },
    network: "restricted",
  },
  policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] },
  windowsSandboxLevel: "disabled",
});

describe("Codex exec-server filesystem sandbox", () => {
  it("permits read-only reads and rejects file and directory writes without changing data", async () => {
    const test = await codexFilesystemFixture();
    const path = "file:///keep.txt";
    const sandbox = restricted([entry("/", "read")]);
    try {
      await test.request("fs/writeFile", { path, dataBase64: base64("original") });
      expect(await test.request("fs/readFile", { path, sandbox })).toMatchObject({
        result: { dataBase64: base64("original") },
      });
      expect(await test.request("fs/getMetadata", { path, sandbox })).toMatchObject({
        result: { isFile: true },
      });
      expect(await test.request("fs/canonicalize", { path, sandbox })).toMatchObject({
        result: { path },
      });
      expect(
        await test.request("fs/writeFile", { path, dataBase64: base64("changed"), sandbox }),
      ).toMatchObject({
        error: { code: -32600 },
      });
      expect(
        await test.request("fs/createDirectory", { path: "file:///new-directory", sandbox }),
      ).toMatchObject({
        error: { code: -32600 },
      });
      expect(readKernelFile(test.filesystem, "/keep.txt")).toBe("original");
      expect(() => test.filesystem.stat("/new-directory")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await test.close();
    }
  });

  it("modifies and creates only under writable roots, including missing descendants", async () => {
    const test = await codexFilesystemFixture();
    const sandbox = restricted([entry("/", "read"), entry("/work", "write")]);
    try {
      await test.request("fs/createDirectory", { path: "file:///work" });
      await test.request("fs/writeFile", {
        path: "file:///work/existing",
        dataBase64: base64("before"),
      });
      expect(
        await test.request("fs/writeFile", {
          path: "file:///work/existing",
          dataBase64: base64("after"),
          sandbox,
        }),
      ).toMatchObject({ result: {} });
      expect(
        await test.request("fs/createDirectory", { path: "file:///work/new/nested", sandbox }),
      ).toMatchObject({ result: {} });
      expect(
        await test.request("fs/writeFile", {
          path: "file:///work/new/nested/file",
          dataBase64: base64("new"),
          sandbox,
        }),
      ).toMatchObject({ result: {} });
      for (const path of ["file:///outside", "file:///work-other"]) {
        expect(
          await test.request("fs/writeFile", { path, dataBase64: base64("denied"), sandbox }),
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(readKernelFile(test.filesystem, "/work/existing")).toBe("after");
      expect(readKernelFile(test.filesystem, "/work/new/nested/file")).toBe("new");
      expect(() => test.filesystem.stat("/outside")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(() => test.filesystem.stat("/work-other")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await test.close();
    }
  });

  it("enforces denied roots on reads, metadata, canonicalization, and writes", async () => {
    const test = await codexFilesystemFixture();
    const sandbox = restricted([
      entry("/", "read"),
      entry("/work", "write"),
      entry("/work/secret", "deny"),
    ]);
    try {
      await test.request("fs/createDirectory", { path: "file:///work/secret" });
      await test.request("fs/writeFile", {
        path: "file:///work/secret/keep",
        dataBase64: base64("private"),
      });
      for (const method of ["fs/readFile", "fs/getMetadata", "fs/canonicalize", "fs/writeFile"]) {
        expect(
          await test.request(method, {
            path: "file:///work/secret/keep",
            dataBase64: base64("denied"),
            sandbox,
          }),
          method,
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(
        await test.request("fs/createDirectory", { path: "file:///work/secret/new", sandbox }),
      ).toMatchObject({ error: { code: -32600 } });
      expect(
        await test.request("fs/writeFile", {
          path: "file:///work/allowed",
          dataBase64: base64("allowed"),
          sandbox,
        }),
      ).toMatchObject({ result: {} });
      expect(readKernelFile(test.filesystem, "/work/secret/keep")).toBe("private");
      expect(() => test.filesystem.stat("/work/secret/new")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await test.close();
    }
  });

  it("resolves symlinks before authorizing writes to existing files and missing descendants", async () => {
    const test = await codexFilesystemFixture();
    const sandbox = restricted([entry("/", "read"), entry("/work", "write")]);
    try {
      await test.request("fs/createDirectory", { path: "file:///work" });
      await test.request("fs/createDirectory", { path: "file:///outside" });
      await test.request("fs/writeFile", {
        path: "file:///outside/keep",
        dataBase64: base64("original"),
      });
      test.filesystem.symlink("/outside", "/work/escape");
      for (const path of ["file:///work/escape/keep", "file:///work/escape/new"]) {
        expect(
          await test.request("fs/writeFile", { path, dataBase64: base64("denied"), sandbox }),
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(
        await test.request("fs/createDirectory", { path: "file:///work/escape/new/deep", sandbox }),
      ).toMatchObject({ error: { code: -32600 } });
      expect(readKernelFile(test.filesystem, "/outside/keep")).toBe("original");
      expect(() => test.filesystem.stat("/outside/new")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await test.close();
    }
  });
});
