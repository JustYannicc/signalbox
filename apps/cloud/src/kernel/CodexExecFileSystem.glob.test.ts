import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { codexFilesystemFixture } from "./tests/CodexExecFileSystemFixture.ts";

type Fixture = Awaited<ReturnType<typeof codexFilesystemFixture>>;
type SandboxEntry = { path: object; access: string };

const base64 = (text: string) => NodeBuffer.Buffer.from(text).toString("base64");
const uri = (path: string) => `file://${path}`;
const entry = (path: string, access: string): SandboxEntry => ({
  path: { type: "path", path: uri(path) },
  access,
});
const glob = (pattern: string): SandboxEntry => ({
  path: { type: "glob_pattern", pattern },
  access: "deny",
});
const restricted = (entries: readonly SandboxEntry[], maxDepth?: number) => ({
  permissions: {
    type: "managed",
    file_system: {
      type: "restricted",
      entries,
      ...(maxDepth === undefined ? {} : { glob_scan_max_depth: maxDepth }),
    },
    network: "restricted",
  },
  policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] },
  windowsSandboxLevel: "disabled",
});
const mkdir = (test: Fixture, path: string) =>
  test.request("fs/createDirectory", { path: uri(path) });
const write = (test: Fixture, path: string, content = "secret") =>
  test.request("fs/writeFile", { path: uri(path), dataBase64: base64(content) });
const read = (test: Fixture, path: string, sandbox: ReturnType<typeof restricted>) =>
  test.request("fs/readFile", { path: uri(path), sandbox });

describe("Codex exec-server filesystem deny globs", () => {
  it("matches globstar, alternatives, and classes while keeping star in one component", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await mkdir(test, "/work/app");
      await mkdir(test, "/work/app/nested");
      await write(test, "/work/app/secret1.env");
      await write(test, "/work/app/secretx.env");
      await write(test, "/work/app/nested/secret2.env");
      await write(test, "/work/app/nested/notes.txt");

      const componentGlob = restricted([entry("/", "read"), glob("/work/app/*.env")]);
      expect(await read(test, "/work/app/secret1.env", componentGlob)).toMatchObject({
        error: { code: -32600 },
      });
      expect(await read(test, "/work/app/nested/secret2.env", componentGlob)).toMatchObject({
        result: { dataBase64: base64("secret") },
      });

      const recursiveGlob = restricted([
        entry("/", "read"),
        glob("/work/app/**/{secret[0-9].env,notes.txt}"),
      ]);
      for (const path of [
        "/work/app/secret1.env",
        "/work/app/nested/secret2.env",
        "/work/app/nested/notes.txt",
      ]) {
        expect(await read(test, path, recursiveGlob), path).toMatchObject({
          error: { code: -32600 },
        });
      }
      expect(await read(test, "/work/app/secretx.env", recursiveGlob)).toMatchObject({
        result: { dataBase64: base64("secret") },
      });
    } finally {
      await test.close();
    }
  });

  it("handles escaped literal paths and unclosed classes", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await mkdir(test, "/work/literal*");
      await mkdir(test, "/work/literal*/deep");
      await mkdir(test, "/work/literalX");
      await mkdir(test, "/work/literalX/deep");
      await write(test, "/work/literal*/deep/secret.env");
      await write(test, "/work/literalX/deep/secret.env");
      await write(test, "/work/literal*name.txt");
      await write(test, "/work/[");

      const escapedPrefix = restricted([entry("/", "read"), glob("/work/literal\\*/deep/*.env")]);
      expect(await read(test, "/work/literal*/deep/secret.env", escapedPrefix)).toMatchObject({
        error: { code: -32600 },
      });
      expect(await read(test, "/work/literalX/deep/secret.env", escapedPrefix)).toMatchObject({
        result: { dataBase64: base64("secret") },
      });

      const escapedLiteral = restricted([entry("/", "read"), glob("/work/literal\\*name.txt")]);
      expect(await read(test, "/work/literal*name.txt", escapedLiteral)).toMatchObject({
        error: { code: -32600 },
      });

      const unclosedClass = restricted([entry("/", "read"), glob("/work/[")]);
      expect(await read(test, "/work/[", unclosedClass)).toMatchObject({
        error: { code: -32600 },
      });
    } finally {
      await test.close();
    }
  });

  it("limits expansion by the configured directory depth", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await mkdir(test, "/work/one");
      await mkdir(test, "/work/one/two");
      await write(test, "/work/.env");
      await write(test, "/work/one/.env");
      await write(test, "/work/one/two/.env");
      await mkdir(test, "/outside");
      await write(test, "/outside/deep");
      test.filesystem.symlink("/outside/deep", "/work/one/two/linked.env");

      const sandbox = restricted([entry("/", "read"), glob("/work/**/*.env")], 2);
      for (const path of ["/work/.env", "/work/one/.env", "/work/one/two/.env"]) {
        expect(await read(test, path, sandbox), path).toMatchObject({ error: { code: -32600 } });
      }
      expect(await read(test, "/outside/deep", sandbox)).toMatchObject({
        result: { dataBase64: base64("secret") },
      });
      expect(
        await read(
          test,
          "/outside/deep",
          restricted([entry("/", "read"), glob("/work/**/*.env")], 3),
        ),
      ).toMatchObject({
        error: { code: -32600 },
      });
    } finally {
      await test.close();
    }
  });

  it("denies matching logical paths through symlinked directories without traversing them", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await mkdir(test, "/work/real");
      await mkdir(test, "/outside");
      await write(test, "/outside/secret.env");
      await write(test, "/outside/alias.env");
      test.filesystem.symlink("/outside/secret.env", "/work/real/linked.env");
      test.filesystem.symlink("/outside", "/work/alias");

      const sandbox = restricted([entry("/", "read"), glob("/work/**/*.env")]);
      expect(await read(test, "/work/real/linked.env", sandbox)).toMatchObject({
        error: { code: -32600 },
      });
      expect(await read(test, "/outside/secret.env", sandbox)).toMatchObject({
        error: { code: -32600 },
      });
      expect(await read(test, "/work/alias/alias.env", sandbox)).toMatchObject({
        error: { code: -32600 },
      });
      expect(await read(test, "/outside/alias.env", sandbox)).toMatchObject({
        result: { dataBase64: base64("secret") },
      });
    } finally {
      await test.close();
    }
  });

  it("rejects malformed or unbounded patterns before reading files", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await write(test, "/work/readme.txt");

      const broadPattern = await read(
        test,
        "/work/readme.txt",
        restricted([entry("/", "read"), glob("/*")]),
      );
      expect(broadPattern).toMatchObject({
        error: {
          code: -32600,
          message: expect.stringContaining("non-root directory prefix"),
        },
      });

      const response = await read(
        test,
        "/work/readme.txt",
        restricted([entry("/", "read"), glob("/work/*{readme,private")]),
      );
      expect(response).toMatchObject({
        error: {
          code: -32600,
          message: expect.stringContaining("error parsing glob"),
        },
      });

      const fileGlob = restricted([entry("/", "read"), glob("/work/**")]);
      expect(
        await test.request("fs/getMetadata", { path: uri("/work"), sandbox: fileGlob }),
      ).toMatchObject({ result: { isDirectory: true } });
    } finally {
      await test.close();
    }
  });

  it("bounds the combined masks across separate deny patterns before reading a file", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      await write(test, "/work/readme.txt", "unchanged");
      for (const prefix of ["a", "b"]) {
        for (let index = 0; index < 4100; index++) await write(test, `/work/${prefix}${index}.env`);
      }
      expect(
        await read(
          test,
          "/work/readme.txt",
          restricted([entry("/", "read"), glob("/work/a*.env"), glob("/work/b*.env")]),
        ),
      ).toMatchObject({
        error: { code: -32600, message: "Filesystem deny globs matched more than 8192 paths" },
      });
      expect(await test.request("fs/readFile", { path: uri("/work/readme.txt") })).toMatchObject({
        result: { dataBase64: base64("unchanged") },
      });
    } finally {
      await test.close();
    }
  });
});
