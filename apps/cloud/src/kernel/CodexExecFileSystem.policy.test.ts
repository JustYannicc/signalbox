import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { codexFilesystemFixture, readKernelFile } from "./tests/CodexExecFileSystemFixture.ts";

const base64 = (text: string) => NodeBuffer.Buffer.from(text).toString("base64");
const entry = (path: string, access: string, extra = {}) => ({
  path: { type: "path", path: `file://${path}` },
  access,
  ...extra,
});
const special = (kind: string, access: string, subpath?: string) => ({
  path: { type: "special", value: { kind, ...(subpath === undefined ? {} : { subpath }) } },
  access,
});
const sandbox = (entries: readonly unknown[], context = {}) => ({
  permissions: {
    type: "managed",
    file_system: { type: "restricted", entries },
    network: "restricted",
  },
  windowsSandboxLevel: "disabled",
  ...context,
});
type Fixture = Awaited<ReturnType<typeof codexFilesystemFixture>>;
const write = (test: Fixture, path: string, text: string, policy?: unknown) =>
  test.request("fs/writeFile", {
    path: `file://${path}`,
    dataBase64: base64(text),
    sandbox: policy,
  });
const mkdir = (test: Fixture, path: string, policy?: unknown) =>
  test.request("fs/createDirectory", { path: `file://${path}`, sandbox: policy });

describe("Codex filesystem permission profiles", () => {
  it("defaults restricted profiles to deny and permits explicitly unrestricted profiles", async () => {
    const test = await codexFilesystemFixture();
    try {
      await write(test, "/keep", "original");
      expect(
        await test.request("fs/readFile", { path: "file:///keep", sandbox: sandbox([]) }),
      ).toMatchObject({ error: { code: -32600 } });
      for (const permissions of [
        { type: "disabled" },
        { type: "external", network: "restricted" },
        { type: "managed", file_system: { type: "unrestricted" }, network: "restricted" },
      ]) {
        expect(
          await write(test, "/keep", "allowed", { permissions, windowsSandboxLevel: "disabled" }),
        ).toMatchObject({ result: {} });
      }
      expect(readKernelFile(test.filesystem, "/keep")).toBe("allowed");
    } finally {
      await test.close();
    }
  });

  it("rejects foreign Windows path conventions before matching POSIX grants", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/C:/scope");
      await write(test, "/C:/scope/file", "original");
      const policy = sandbox([entry("/", "read"), entry("/C:/scope", "write")], {
        policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] },
      });
      expect(await write(test, "/C:/scope/file", "forbidden", policy)).toMatchObject({
        error: { code: -32602 },
      });
      expect(await write(test, "/keep", "forbidden", policy)).toMatchObject({
        error: { code: -32602 },
      });
      expect(readKernelFile(test.filesystem, "/C:/scope/file")).toBe("original");
    } finally {
      await test.close();
    }
  });

  it("reopens a more-specific writable descendant and lets an equal-path denial win in either order", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work/private/reopened");
      const rules = [
        entry("/", "read"),
        entry("/work", "write"),
        entry("/work/private", "deny"),
        entry("/work/private/reopened", "write"),
      ];
      expect(
        await write(test, "/work/private/reopened/file", "allowed", sandbox(rules)),
      ).toMatchObject({ result: {} });
      expect(
        await test.request("fs/readFile", {
          path: "file:///work/private/reopened/file",
          sandbox: sandbox(rules),
        }),
      ).toMatchObject({ result: { dataBase64: base64("allowed") } });
      for (const entries of [rules, rules.toReversed()]) {
        expect(
          await write(
            test,
            "/work/private/reopened/file",
            "denied",
            sandbox([...entries, entry("/work/private/reopened/file", "none")]),
          ),
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(readKernelFile(test.filesystem, "/work/private/reopened/file")).toBe("allowed");
    } finally {
      await test.close();
    }
  });

  it("uses explicit policy context before legacy roots and requires cwd for dynamic permissions", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work/sub");
      await mkdir(test, "/legacy");
      const rules = [special("root", "read"), special("project_roots", "write", "sub")];
      const policy = sandbox(rules, {
        cwd: "file:///legacy",
        workspaceRoots: ["file:///legacy"],
        policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] },
      });
      expect(await write(test, "/work/sub/file", "allowed", policy)).toMatchObject({ result: {} });
      expect(await write(test, "/legacy/file", "denied", policy)).toMatchObject({
        error: { code: -32600 },
      });
      expect(
        await write(
          test,
          "/work/sub/file",
          "denied",
          sandbox(rules, { workspaceRoots: ["file:///work"] }),
        ),
      ).toMatchObject({ error: { code: -32602 } });
      expect(readKernelFile(test.filesystem, "/work/sub/file")).toBe("allowed");
    } finally {
      await test.close();
    }
  });

  it("keeps invalid project-root subpaths inside their scope and preserves deny fallback", async () => {
    const test = await codexFilesystemFixture();
    const context = { policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] } };
    try {
      await mkdir(test, "/work/sub");
      for (const subpath of ["../outside", "/work/sub", "sub/./child"]) {
        expect(
          await write(
            test,
            "/work/sub/file",
            "denied",
            sandbox([special("project_roots", "write", subpath)], context),
          ),
        ).toMatchObject({ error: { code: -32600 } });
        expect(
          await write(
            test,
            "/work/sub/file",
            "denied",
            sandbox([entry("/work", "write"), special("project_roots", "read", subpath)], context),
          ),
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(
        await write(
          test,
          "/work/sub/file",
          "denied",
          sandbox(
            [entry("/work", "write"), special("project_roots", "deny", "~/private")],
            context,
          ),
        ),
      ).toMatchObject({ error: { code: -32600 } });
      expect(() => test.filesystem.stat("/work/sub/file")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      await test.close();
    }
  });

  it("skips missing writable grants and masks the first missing denied component unless explicitly skipped", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work");
      expect(
        await mkdir(test, "/work/new", sandbox([entry("/", "read"), entry("/work/new", "write")])),
      ).toMatchObject({ error: { code: -32600 } });
      const rules = [entry("/", "read"), entry("/work", "write")];
      expect(
        await mkdir(
          test,
          "/work/new/other",
          sandbox([...rules, entry("/work/new/private", "deny")]),
        ),
      ).toMatchObject({ error: { code: -32600 } });
      expect(() => test.filesystem.stat("/work/new")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(
        await mkdir(
          test,
          "/work/new/other",
          sandbox([
            ...rules,
            entry("/work/new/private", "deny", { missing_path_behavior: "skip" }),
          ]),
        ),
      ).toMatchObject({ result: {} });
    } finally {
      await test.close();
    }
  });

  it("recognizes canonical writable roots and refuses carveouts across a writable symlink", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/physical/private");
      test.filesystem.symlink("/physical", "/alias");
      const grant = [entry("/", "read"), entry("/alias", "write")];
      expect(await write(test, "/physical/file", "allowed", sandbox(grant))).toMatchObject({
        result: {},
      });
      test.filesystem.symlink("/physical/private", "/physical/mutable");
      expect(
        await write(
          test,
          "/physical/file",
          "denied",
          sandbox([...grant, entry("/alias/mutable", "read")]),
        ),
      ).toMatchObject({ error: { code: -32600 } });
      expect(readKernelFile(test.filesystem, "/physical/file")).toBe("allowed");
    } finally {
      await test.close();
    }
  });

  it("protects existing metadata and missing workspace .codex while honoring narrower explicit writes", async () => {
    const test = await codexFilesystemFixture();
    const context = { policyContext: { cwd: "file:///work", workspaceRoots: ["file:///work"] } };
    const rules = [entry("/", "read"), entry("/work", "write")];
    try {
      for (const path of ["/work/.git", "/work/.agents", "/work/.aws"]) await mkdir(test, path);
      for (const name of [".git", ".agents", ".codex", ".aws"]) {
        expect(
          await write(test, `/work/${name}/file`, "denied", sandbox(rules, context)),
        ).toMatchObject({ error: { code: -32600 } });
      }
      expect(await mkdir(test, "/work/.codex", sandbox(rules, context))).toMatchObject({
        error: { code: -32600 },
      });
      expect(() => test.filesystem.stat("/work/.codex")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(
        await write(
          test,
          "/work/.git/allowed",
          "allowed",
          sandbox([...rules, entry("/work/.git", "write")], context),
        ),
      ).toMatchObject({ result: {} });
      expect(readKernelFile(test.filesystem, "/work/.git/allowed")).toBe("allowed");
    } finally {
      await test.close();
    }
  });

  it("protects a worktree gitdir reached through its .git pointer", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/work/repository");
      await mkdir(test, "/work/git-state");
      await write(test, "/work/repository/.git", "gitdir: ../git-state\n");
      await write(test, "/work/git-state/index", "original");
      const rules = [
        entry("/", "read"),
        entry("/work", "write"),
        entry("/work/repository", "write"),
      ];
      expect(await write(test, "/work/git-state/index", "denied", sandbox(rules))).toMatchObject({
        error: { code: -32600 },
      });
      expect(readKernelFile(test.filesystem, "/work/git-state/index")).toBe("original");
    } finally {
      await test.close();
    }
  });

  it("resolves supplied temporary directories and includes Linux helper runtime reads", async () => {
    const test = await codexFilesystemFixture();
    try {
      await mkdir(test, "/selected-temp");
      await mkdir(test, "/usr/share");
      await write(test, "/usr/share/runtime", "runtime bytes");
      const policy = sandbox([special("tmpdir", "write")], {
        temporaryDirectories: ["file:///selected-temp"],
      });
      expect(await write(test, "/selected-temp/file", "allowed", policy)).toMatchObject({
        result: {},
      });
      expect(await write(test, "/outside", "denied", policy)).toMatchObject({
        error: { code: -32600 },
      });
      expect(
        await test.request("fs/readFile", { path: "file:///usr/share/runtime", sandbox: policy }),
      ).toMatchObject({ result: { dataBase64: base64("runtime bytes") } });
      expect(await write(test, "/usr/share/runtime", "denied", policy)).toMatchObject({
        error: { code: -32600 },
      });
    } finally {
      await test.close();
    }
  });
});
