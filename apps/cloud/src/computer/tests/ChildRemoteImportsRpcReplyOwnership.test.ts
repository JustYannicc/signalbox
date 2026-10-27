import { describe, expect, it } from "vite-plus/test";
import { createChildBashImports } from "../ChildBashImports.ts";
import { createChildBusyboxImports } from "../ChildBusyboxImports.ts";
import { createChildCoreutilsImports } from "../ChildCoreutilsImports.ts";
import { createChildGitImports } from "../ChildGitImports.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import type { KernelGitPort } from "../../kernel/KernelGitPort.ts";
import { disposable, importReactor, instantiateImports } from "./ChildRpcReplyTestFixture.ts";

const invalid = { pointer: 65_536, bytes: new Uint8Array([1]) };

describe("ChildBashImports RPC reply ownership", () => {
  it("copies callBash memory and disposes replies after valid and invalid application", async () => {
    const module = importReactor("nimbus_proc", "capture_cwd", 2);
    const valid = disposable({
      value: 0,
      regions: [{ pointer: 32, bytes: Uint8Array.from([99, 119, 100, 0]) }],
    });
    const bad = disposable({ value: 0, regions: [invalid] });
    const replies = [valid.reply, bad.reply];
    let calls = 0;
    const port: Pick<KernelBashPort, "callBash"> = {
      async callBash() {
        return replies[calls++]!;
      },
    };
    const guest = instantiateImports(module, createChildBashImports({ module, port }));

    await expect(guest.run(32, 8)).resolves.toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(guest.memory.buffer, 32, 4))).toBe("cwd\0");
    expect(valid.count()).toBe(1);
    expect(valid.receiverWasReply()).toBe(true);
    await expect(guest.run(32, 8)).rejects.toThrow("Invalid syscall memory response regions");
    expect(bad.count()).toBe(1);
  });

  it("propagates an aborted callBash RPC without inventing a reply", async () => {
    const module = importReactor("nimbus_proc", "capture_cwd", 2);
    const abort = new DOMException("operation aborted", "AbortError");
    const port: Pick<KernelBashPort, "callBash"> = {
      async callBash() {
        throw abort;
      },
    };
    const guest = instantiateImports(module, createChildBashImports({ module, port }));

    await expect(guest.run(32, 8)).rejects.toBe(abort);
  });
});

describe("ChildBusyboxImports RPC reply ownership", () => {
  it("copies callBusybox metadata and disposes replies after valid and invalid application", async () => {
    const module = importReactor("nimbus_proc", "stat_metadata", 5);
    const metadata = new Uint8Array(12);
    new DataView(metadata.buffer).setUint32(0, 0o100644, true);
    const valid = disposable({ value: 0, regions: [{ pointer: 64, bytes: metadata }] });
    const bad = disposable({ value: 0, regions: [invalid] });
    const replies = [valid.reply, bad.reply];
    let calls = 0;
    const port: Pick<KernelBusyboxPort, "callBusybox"> = {
      async callBusybox() {
        return replies[calls++]!;
      },
    };
    const guest = instantiateImports(module, createChildBusyboxImports({ module, port }));

    await expect(guest.run(-1, 32, 6, 1, 64)).resolves.toBe(0);
    expect(new DataView(guest.memory.buffer).getUint32(64, true)).toBe(0o100644);
    expect(valid.count()).toBe(1);
    await expect(guest.run(-1, 32, 6, 1, 64)).rejects.toThrow(
      "Invalid syscall memory response regions",
    );
    expect(bad.count()).toBe(1);
  });

  it("propagates an aborted callBusybox RPC without inventing a reply", async () => {
    const module = importReactor("nimbus_proc", "stat_metadata", 5);
    const abort = new DOMException("operation aborted", "AbortError");
    const port: Pick<KernelBusyboxPort, "callBusybox"> = {
      async callBusybox() {
        throw abort;
      },
    };
    const guest = instantiateImports(module, createChildBusyboxImports({ module, port }));

    await expect(guest.run(-1, 32, 6, 1, 64)).rejects.toBe(abort);
  });
});

describe("ChildCoreutilsImports RPC reply ownership", () => {
  it("copies callCoreutils output and disposes replies after valid and invalid application", async () => {
    const module = importReactor("host_fs", "fd_owner", 3);
    const uid = new Uint8Array(4);
    const gid = new Uint8Array(4);
    new DataView(uid.buffer).setUint32(0, 1000, true);
    new DataView(gid.buffer).setUint32(0, 1001, true);
    const valid = disposable({
      value: 0,
      regions: [
        { pointer: 64, bytes: uid },
        { pointer: 68, bytes: gid },
      ],
    });
    const bad = disposable({ value: 0, regions: [invalid] });
    const replies = [valid.reply, bad.reply];
    let calls = 0;
    const port: Pick<KernelCoreutilsPort, "callCoreutils"> = {
      async callCoreutils() {
        return replies[calls++]!;
      },
    };
    const guest = instantiateImports(module, createChildCoreutilsImports({ module, port }));

    await expect(guest.run(0, 64, 68)).resolves.toBe(0);
    const view = new DataView(guest.memory.buffer);
    expect([view.getUint32(64, true), view.getUint32(68, true)]).toEqual([1000, 1001]);
    expect(valid.count()).toBe(1);
    await expect(guest.run(0, 64, 68)).rejects.toThrow("Invalid syscall memory response regions");
    expect(bad.count()).toBe(1);
  });

  it("propagates an aborted callCoreutils RPC without inventing a reply", async () => {
    const module = importReactor("host_fs", "fd_owner", 3);
    const abort = new DOMException("operation aborted", "AbortError");
    const port: Pick<KernelCoreutilsPort, "callCoreutils"> = {
      async callCoreutils() {
        throw abort;
      },
    };
    const guest = instantiateImports(module, createChildCoreutilsImports({ module, port }));

    await expect(guest.run(0, 64, 68)).rejects.toBe(abort);
  });
});

describe("ChildGitImports RPC reply ownership", () => {
  it("copies callGit metadata and disposes replies after valid and invalid application", async () => {
    const module = importReactor("nimbus_fs", "fd_stat", 2);
    const stat = new Uint8Array(80);
    new DataView(stat.buffer).setUint32(0, 0o100644, true);
    const valid = disposable({ value: 0, regions: [{ pointer: 64, bytes: stat }] });
    const bad = disposable({ value: 0, regions: [invalid] });
    const replies = [valid.reply, bad.reply];
    let calls = 0;
    const port: Pick<KernelGitPort, "callGit"> = {
      async callGit() {
        return replies[calls++]!;
      },
    };
    const guest = instantiateImports(module, createChildGitImports({ module, port }));

    await expect(guest.run(3, 64)).resolves.toBe(0);
    expect(new DataView(guest.memory.buffer).getUint32(64, true)).toBe(0o100644);
    expect(valid.count()).toBe(1);
    await expect(guest.run(3, 64)).rejects.toThrow("Invalid syscall memory response regions");
    expect(bad.count()).toBe(1);
  });

  it("propagates an aborted callGit RPC without inventing a reply", async () => {
    const module = importReactor("nimbus_fs", "fd_stat", 2);
    const abort = new DOMException("operation aborted", "AbortError");
    const port: Pick<KernelGitPort, "callGit"> = {
      async callGit() {
        throw abort;
      },
    };
    const guest = instantiateImports(module, createChildGitImports({ module, port }));

    await expect(guest.run(3, 64)).rejects.toBe(abort);
  });
});
