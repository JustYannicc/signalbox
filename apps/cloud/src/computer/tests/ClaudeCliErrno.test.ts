import { describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createNodeFsSyscallClient } from "../../isolate/NodeFsSyscallClient.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { KernelOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { HarnessError, serializeHarnessFailure } from "../../harness/Harness.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";
import { cliFileBackendFixture } from "./helpers/cliFileBackend.ts";
import type {
  NodeFsOperation,
  NodeFsArguments,
  NodeFsResult,
} from "../../isolate/NodeFsBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function portFixture() {
  const owned = createTestFilesystem(undefined, {
    credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
    umask: 0o022,
  });
  const canonical = createNodeFs(owned.filesystem).fs;
  canonical.writeFileSync("/source", "kept");
  canonical.mkdirSync("/private");
  canonical.writeFileSync("/private/file", "denied");
  canonical.chmodSync("/private/file", 0);
  canonical.chmodSync("/private", 0o555);
  const root = owned.filesystem.open("/", KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY);
  const host = createKernelSyscallHost({
    filesystem: owned.filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
    nimbusMetadata: true,
  });
  const client = createNodeFsSyscallClient({
    rootDescriptor: root,
    posix: true,
    syscalls: {
      call: async (request) => structuredClone(await host.call(structuredClone(request))),
    },
  });
  const backend = Object.assign(owned.filesystem, {
    asynchronous<K extends NodeFsOperation>(
      name: K,
      args: NodeFsArguments<K>,
      signal?: AbortSignal,
    ): Promise<NodeFsResult<K>> {
      return client.call(name, args, signal);
    },
  });
  return {
    client,
    fs: createNodeFs(backend).fs,
    canonical,
    close() {
      host.close();
      owned.close();
    },
  };
}

async function failure(operation: () => unknown) {
  try {
    await operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("The denied filesystem operation unexpectedly succeeded");
}

describe("CLI errno diagnostics through the real kernel port", () => {
  it.each([
    { syscall: "stat", code: "ENOENT", errno: -2, path: "/missing" },
    { syscall: "open", code: "EACCES", errno: -13, path: "/private/file" },
    { syscall: "mkdir", code: "EEXIST", errno: -17, path: "/private" },
    {
      syscall: "rename",
      code: "ENOENT",
      errno: -2,
      path: "/source",
      dest: "/missing-parent/moved",
    },
    { syscall: "link", code: "ENOENT", errno: -2, path: "/source", dest: "/missing-parent/linked" },
    {
      syscall: "symlink",
      code: "ENOENT",
      errno: -2,
      path: "/missing-target",
      dest: "/missing-parent/linked",
    },
  ])(
    "preserves $syscall errno and operands across the actual syscall response",
    async (expected) => {
      const f = portFixture();
      try {
        const error = await failure(() => {
          switch (expected.syscall) {
            case "stat":
              return f.client.stat(expected.path);
            case "open":
              return f.client.open(expected.path, KernelOpenFlags.O_RDONLY);
            case "mkdir":
              return f.client.mkdir(expected.path);
            case "rename":
              return f.client.rename(expected.path, expected.dest!);
            case "link":
              return f.client.link(expected.path, expected.dest!);
            case "symlink":
              return f.client.symlink(expected.path, expected.dest!);
          }
        });
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject(expected);
        expect(String(error)).toContain(expected.code);
        expect(String(error)).toContain(expected.path);
        expect(f.canonical.readFileSync("/source", "utf8")).toBe("kept");
        if (expected.dest !== undefined) expect(f.canonical.existsSync(expected.dest)).toBe(false);
      } finally {
        f.close();
      }
    },
  );

  it("retains public Node error context through the actual HarnessError codec", async () => {
    const f = portFixture();
    try {
      const cause = await failure(() => f.fs.promises.rename("/source", "/missing-parent/moved"));
      const expected = {
        code: "ENOENT",
        errno: -2,
        syscall: "rename",
        path: "/source",
        dest: "/missing-parent/moved",
      };
      expect(cause).toMatchObject(expected);
      expect(serializeHarnessFailure(cause)).toMatchObject(expected);
      const error = new HarnessError({
        operation: "open",
        message: "Public session could not open",
        cause,
      });
      const wire = Schema.encodeSync(HarnessError)(error);
      const restored = Schema.decodeUnknownSync(HarnessError)(JSON.parse(JSON.stringify(wire)));
      expect(restored.cause).toBeInstanceOf(Error);
      expect(restored.cause).toMatchObject(expected);
    } finally {
      f.close();
    }
  });

  it("indexes a denied directory while preserving actual public access errors", async () => {
    const f = await cliFileBackendFixture(128, ["/sync"], true, {
      seed: (fs) => {
        fs.mkdirSync("/blocked");
        fs.writeFileSync("/blocked/hidden", "private");
        fs.chmodSync("/blocked", 0);
        fs.mkdirSync("/read-only");
        fs.writeFileSync("/read-only/listed", "readable name");
        fs.chmodSync("/read-only", 0o400);
      },
    });
    try {
      expect(f.fs.statSync("/blocked").isDirectory()).toBe(true);
      expect((await f.fs.promises.stat("/blocked")).isDirectory()).toBe(true);
      for (const operation of [
        () => f.fs.readdirSync("/blocked"),
        () => f.fs.promises.readdir("/blocked"),
      ])
        expect(await failure(operation)).toMatchObject({
          code: "EACCES",
          errno: -13,
          syscall: "scandir",
          path: "/blocked",
        });
      for (const operation of [
        () => f.fs.statSync("/blocked/hidden"),
        () => f.fs.promises.stat("/blocked/hidden"),
        () => f.fs.statSync("/blocked/missing"),
        () => f.fs.promises.stat("/blocked/missing"),
      ])
        expect(await failure(operation)).toMatchObject({
          code: "EACCES",
          errno: -13,
          syscall: "stat",
        });
      expect(f.fs.readdirSync("/read-only")).toEqual(["listed"]);
      expect(await f.fs.promises.readdir("/read-only")).toEqual(["listed"]);
      expect(await failure(() => f.fs.statSync("/read-only/listed"))).toMatchObject({
        code: "EACCES",
        errno: -13,
        syscall: "stat",
        path: "/read-only/listed",
      });
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("drops an indexed denial once the CLI grants access, without inventing unseen entries", async () => {
    const f = await cliFileBackendFixture(128, ["/sync"], true, {
      seed: (fs) => {
        fs.mkdirSync("/blocked");
        fs.writeFileSync("/blocked/hidden", "private");
        fs.chmodSync("/blocked", 0);
        fs.mkdirSync("/read-only");
        fs.writeFileSync("/read-only/listed", "readable name");
        fs.chmodSync("/read-only", 0o400);
      },
    });
    try {
      f.fs.chmodSync("/read-only", 0o500);
      expect(await failure(() => f.fs.statSync("/read-only/listed"))).toMatchObject({
        code: "EIO",
        path: "/read-only/listed",
      });
      expect((await f.fs.promises.stat("/read-only/listed")).isFile()).toBe(true);

      f.fs.chmodSync("/blocked", 0o700);
      expect(await failure(() => f.fs.readdirSync("/blocked"))).toMatchObject({
        code: "EIO",
        path: "/blocked",
      });
      expect(await f.fs.promises.readdir("/blocked")).toEqual(["hidden"]);
      // Never a false success that the queued remote mkdir would then contradict.
      expect(await failure(() => f.fs.mkdirSync("/blocked/hidden"))).toMatchObject({
        code: "EEXIST",
      });

      f.fs.chmodSync("/read-only", 0o700);
      f.fs.writeFileSync("/read-only/created", "new");
      expect(f.fs.readdirSync("/read-only").sort()).toEqual(["created", "listed"]);
      expect(await failure(() => f.fs.statSync("/read-only/absent"))).toMatchObject({
        code: "ENOENT",
      });

      f.fs.chmodSync("/read-only", 0o400);
      expect(await failure(() => f.fs.statSync("/read-only/listed"))).toMatchObject({
        code: "EACCES",
        syscall: "stat",
      });
    } finally {
      await f.close();
    }
  });
});
