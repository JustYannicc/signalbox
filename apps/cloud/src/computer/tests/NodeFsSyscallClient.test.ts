import { describe, expect, it } from "vite-plus/test";
import { createNodeFsSyscallClient } from "../../isolate/NodeFsSyscallClient.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import type {
  NodeFsOperation,
  NodeFsArguments,
  NodeFsResult,
} from "../../isolate/NodeFsBackend.ts";
import { KernelOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import {
  KERNEL_SYSCALL_MAX_IO_BYTES,
  type KernelSyscallRequest,
  type KernelSyscallResponse,
} from "../../kernel/KernelSyscallPort.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

function fixture() {
  const owned = createTestFilesystem();
  const root = owned.filesystem.open("/", KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY);
  const requests: KernelSyscallRequest[] = [];
  const host = createKernelSyscallHost({
    filesystem: owned.filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
    nimbusMetadata: true,
  });
  const client = createNodeFsSyscallClient({
    syscalls: {
      call: (request) => {
        requests.push(request);
        return host.call(request);
      },
    },
    rootDescriptor: root,
    posix: false,
  });
  return {
    ...owned,
    client,
    requests,
    close() {
      host.close();
      owned.close();
    },
  };
}

describe("Node fs syscall client", () => {
  it("uses the owner's descriptors and preserves offset, positional I/O and truncation", async () => {
    const owned = fixture();
    try {
      const fd = await owned.client.call("open", [
        "/file",
        KernelOpenFlags.O_RDWR | KernelOpenFlags.O_CREAT,
        0o600,
      ]);
      expect(owned.filesystem.descriptors.has(fd)).toBe(true);
      expect(await owned.client.call("write", [fd, new TextEncoder().encode("hello"), null])).toBe(
        5,
      );
      expect(await owned.client.position(fd)).toBe(5n);
      const target = new Uint8Array(3);
      expect(await owned.client.call("read", [fd, target, 1n])).toBe(3);
      expect(new TextDecoder().decode(target)).toBe("ell");
      expect(await owned.client.position(fd)).toBe(5n);
      await owned.client.call("ftruncate", [fd, 2n]);
      expect((await owned.client.call("fstat", [fd])).size).toBe(2n);
      await owned.client.call("close", [fd]);
      expect(owned.filesystem.descriptors.has(fd)).toBe(false);
      await expect(owned.client.call("fstat", [fd])).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      owned.close();
    }
  });

  it("forwards async Node APIs without invoking their synchronous working-set branch", async () => {
    const owned = fixture();
    try {
      const backend = Object.assign(owned.filesystem, {
        asynchronous<K extends NodeFsOperation>(
          name: K,
          args: NodeFsArguments<K>,
          signal?: AbortSignal,
        ): Promise<NodeFsResult<K>> {
          return owned.client.call(name, args, signal);
        },
      });
      const fs = createNodeFs(backend).fs;
      await fs.promises.writeFile("/file", "remote bytes");
      expect(await fs.promises.readFile("/file", "utf8")).toBe("remote bytes");
      expect((await fs.promises.stat("/file")).size).toBe(12);
      expect(owned.requests.some((request) => request.name === "fd_write")).toBe(true);
      expect(owned.requests.some((request) => request.name === "fd_read")).toBe(true);
      expect(owned.requests.some((request) => request.name === "path_filestat_get")).toBe(true);
      const handle = await fs.promises.open("/file");
      await handle.close();
      expect(owned.filesystem.descriptors.has(handle.fd)).toBe(false);
    } finally {
      owned.close();
    }
  });

  it("bounds every transferred data range and propagates filesystem errno", async () => {
    const owned = fixture();
    try {
      const fd = await owned.client.call("open", [
        "/large",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      ]);
      const bytes = new Uint8Array(KERNEL_SYSCALL_MAX_IO_BYTES + 31).fill(7);
      expect(await owned.client.call("write", [fd, bytes, null])).toBe(KERNEL_SYSCALL_MAX_IO_BYTES);
      const output = new Uint8Array(bytes.length);
      expect(await owned.client.call("read", [fd, output, 0n])).toBe(KERNEL_SYSCALL_MAX_IO_BYTES);
      for (const request of owned.requests.filter(
        (item) => item.name === "fd_write" || item.name === "fd_pread",
      ))
        for (const region of request.regions)
          expect(region.length ?? region.bytes.byteLength).toBeLessThanOrEqual(
            KERNEL_SYSCALL_MAX_IO_BYTES,
          );
      await owned.client.call("close", [fd]);
      await expect(owned.client.call("stat", ["/missing"])).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      owned.close();
    }
  });

  it("keeps links, directory operations and canonical paths in the owner", async () => {
    const owned = fixture();
    try {
      await owned.client.call("mkdir", ["/dir"]);
      const fd = await owned.client.call("open", [
        "/dir/a",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      ]);
      await owned.client.call("close", [fd]);
      await owned.client.call("symlink", ["a", "/dir/link"]);
      expect((await owned.client.call("lstat", ["/dir/link"])).type).toBe("symlink");
      expect(await owned.client.call("realpath", ["/dir/link"])).toBe("/dir/a");
      expect(await owned.client.call("readlink", ["/dir/link"])).toBe("a");
      await owned.client.call("rename", ["/dir/a", "/dir/b"]);
      expect((await owned.client.call("readdir", ["/dir"])).sort()).toEqual(["b", "link"]);
      await owned.client.call("symlink", ["dir", "/dir-link"]);
      expect((await owned.client.call("readdir", ["/dir-link"])).sort()).toEqual(["b", "link"]);
      await expect(
        owned.client.call("open", [
          "/dir-link",
          KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_NOFOLLOW,
        ]),
      ).rejects.toMatchObject({ code: "ELOOP" });
      await owned.client.call("unlink", ["/dir-link"]);
      await owned.client.call("unlink", ["/dir/link"]);
      await owned.client.call("unlink", ["/dir/b"]);
      await owned.client.call("rmdir", ["/dir"]);
      await expect(owned.client.call("stat", ["/dir"])).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      owned.close();
    }
  });

  it("propagates exit and signal responses and rejects output outside the caller's reservation", async () => {
    const client = (response: KernelSyscallResponse) =>
      createNodeFsSyscallClient({
        rootDescriptor: 3,
        posix: false,
        syscalls: { call: async () => response },
      });
    await expect(client({ kind: "exit", code: 23 }).call("close", [4])).rejects.toMatchObject({
      code: 23,
    });
    await expect(client({ kind: "signal", signal: 15 }).call("close", [4])).rejects.toMatchObject({
      signal: 15,
    });
    await expect(
      client({
        kind: "return",
        value: 0,
        regions: [{ pointer: 32, bytes: new Uint8Array(8) }],
      }).call("close", [4]),
    ).rejects.toThrow("outside the syscall output reservation");
  });

  it("joins cancellation of an in-flight syscall before exposing its aborted completion", async () => {
    const entered = Promise.withResolvers<string>();
    const cancelled = Promise.withResolvers<void>();
    const response = Promise.withResolvers<KernelSyscallResponse>();
    const cancellationFinished = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("CLI read cancelled");
    const client = createNodeFsSyscallClient({
      rootDescriptor: 3,
      posix: false,
      syscalls: {
        async call(request) {
          entered.resolve(request.operationId!);
          return await response.promise;
        },
        async cancel(id, cause) {
          expect(id).toBe(await entered.promise);
          expect(cause).toBe(reason);
          cancelled.resolve();
          await cancellationFinished.promise;
        },
      },
    });
    let settled = false;
    const pending = client.call("close", [4], controller.signal);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    controller.abort(reason);
    await cancelled.promise;
    response.resolve({ kind: "return", value: 0, regions: [] });
    await Promise.resolve();
    expect(settled).toBe(false);
    cancellationFinished.resolve();
    await expect(pending).rejects.toBe(reason);
  });

  it("cancels a stream's pending open lookup and joins it before closing the stream", async () => {
    const owned = createTestFilesystem();
    const lifetime = new AbortController();
    const entered = Promise.withResolvers<KernelSyscallRequest>();
    const response = Promise.withResolvers<KernelSyscallResponse>();
    const cancellationFinished = Promise.withResolvers<void>();
    const cancellations: { readonly id: string; readonly reason: unknown }[] = [];
    const client = createNodeFsSyscallClient({
      rootDescriptor: 3,
      posix: false,
      signal: lifetime.signal,
      syscalls: {
        async call(request) {
          entered.resolve(request);
          return await response.promise;
        },
        async cancel(id, reason) {
          cancellations.push({ id, reason });
          await cancellationFinished.promise;
        },
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
    const stream = createNodeFs(backend).fs.createReadStream("/pending");
    stream.on("error", () => {});
    let closed = false;
    const finished = new Promise<void>((resolve) => {
      stream.once("close", () => {
        closed = true;
        resolve();
      });
    });
    stream.resume();
    const request = await entered.promise;
    const reason = new Error("Stream read cancelled");
    try {
      expect(request.name).toBe("path_filestat_get");
      stream.destroy(reason);
      expect(cancellations).toEqual([{ id: request.operationId, reason }]);
      response.resolve({ kind: "return", value: 0, regions: [] });
      await Promise.resolve();
      expect(closed).toBe(false);
      cancellationFinished.resolve();
      await finished;
      expect(lifetime.signal.aborted).toBe(false);
    } finally {
      stream.destroy();
      response.resolve({ kind: "return", value: 44, regions: [] });
      cancellationFinished.resolve();
      await finished;
      owned.close();
    }
  });
});
