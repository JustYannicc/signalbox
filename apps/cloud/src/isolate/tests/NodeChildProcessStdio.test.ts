import { describe, expect, it } from "@effect/vitest";

import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, type WasiStdio } from "../../kernel/KernelFileSystem.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import {
  KernelProgramHost,
  type KernelInlineProgram,
  type KernelProgramBinding,
} from "../../kernel/KernelProgramHost.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
import {
  createNodeChildProcess,
  type NodeChildProcess,
  type NodeChildProcessContext,
} from "../NodeChildProcess.ts";
import { createNodeFs } from "../NodeFs.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

function harness(
  runInline: KernelInlineProgram,
  stdio?: readonly [WasiStdio, WasiStdio, WasiStdio],
) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
    ...(stdio === undefined ? {} : { stdio }),
  });
  filesystem.mkdir("/work");
  filesystem.chdir("/work");

  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "stdio-tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.spawn"] as const,
    entrypoint: "stdio-tool",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  const binding: KernelProgramBinding = {
    manifest,
    implementation: { kind: "javascript", runInline },
  };
  const processes = new KernelProcessTable({ wakes });
  const programHost = new KernelProgramHost({
    registry,
    wakes,
    processes,
    programs: new Map([["/bin/stdio-tool", binding]]),
  });
  const context: NodeChildProcessContext = {
    filesystem,
    env: { PATH: "/bin", HOME: "/work/home" },
    home: "/work/home",
  };
  const childProcess = createNodeChildProcess(programHost, context);
  const nodeFs = createNodeFs(filesystem).fs;

  return {
    childProcess,
    filesystem,
    nodeFs,
    programHost,
    wakes,
    async close() {
      await processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

function closed(child: NodeChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function output(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.on("data", (chunk: Uint8Array) => (value += new TextDecoder().decode(chunk)));
    stream.once("end", () => resolve(value));
    stream.once("error", reject);
  });
}

function spawnError(child: NodeChildProcess): Promise<Error> {
  return new Promise((resolve) => child.once("error", resolve));
}

describe("Node child_process stdio over the kernel host", () => {
  it("uses pipes for null and undefined array slots", async () => {
    const host = harness(({ filesystem }) => {
      filesystem.write(1, bytes("out"), null);
      filesystem.write(2, bytes("err"), null);
      return 0;
    });
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: [undefined, null, undefined],
      });
      const stdin = child.stdin;
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdin || !stdout || !stderr) throw new Error("Expected three child pipes");
      const stdoutText = output(stdout);
      const stderrText = output(stderr);
      const childClosed = closed(child);
      stdin.end();
      await childClosed;

      expect(await stdoutText).toBe("out");
      expect(await stderrText).toBe("err");
      expect(child.stdio).toEqual([stdin, stdout, stderr]);
    } finally {
      await host.close();
    }
  });

  it("gives ignored stdin EOF and discards ignored output without exposing streams", async () => {
    const reads: number[] = [];
    const host = harness(({ filesystem }) => {
      const input = new Uint8Array(16);
      reads.push(filesystem.read(0, input, null));
      filesystem.write(1, bytes("discard stdout"), null);
      filesystem.write(2, bytes("discard stderr"), null);
      return 0;
    });
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: ["ignore", "ignore", "ignore"],
      });
      expect(child.stdin).toBeNull();
      expect(child.stdout).toBeNull();
      expect(child.stderr).toBeNull();
      expect(child.stdio).toEqual([null, null, null]);
      const childClosed = closed(child);
      await childClosed;
      expect(reads).toEqual([0]);
    } finally {
      await host.close();
    }
  });

  it("lets exec collect an empty result when ignored streams are null", async () => {
    const host = harness(() => 0);
    try {
      const result = new Promise<{ error: Error | null; stdout: string; stderr: string }>(
        (resolve) => {
          host.childProcess.execFile(
            "/bin/stdio-tool",
            { stdio: ["ignore", "ignore", "ignore"] },
            (error, stdout, stderr) =>
              resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
          );
        },
      );

      expect(await result).toEqual({ error: null, stdout: "", stderr: "" });
    } finally {
      await host.close();
    }
  });

  it("aliases numeric stdout and stderr onto one parent open description", async () => {
    const host = harness(({ filesystem }) => {
      filesystem.write(1, bytes("out"), null);
      filesystem.write(2, bytes("err"), null);
      return 0;
    });
    const path = "/work/stdio.txt";
    host.nodeFs.writeFileSync(path, "");
    const fd = host.nodeFs.openSync(path, "r+");
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: ["ignore", fd, fd],
      });
      const childClosed = closed(child);
      expect(child.stdin).toBeNull();
      expect(child.stdout).toBeNull();
      expect(child.stderr).toBeNull();
      await childClosed;

      expect(host.filesystem.descriptors.has(fd)).toBe(true);
      const atSharedOffset = new Uint8Array(1);
      expect(host.nodeFs.readSync(fd, atSharedOffset, 0, 1, null)).toBe(0);
      expect(host.nodeFs.readFileSync(path).toString()).toBe("outerr");
      const fromStart = new Uint8Array(6);
      expect(host.nodeFs.readSync(fd, fromStart, 0, fromStart.byteLength, 0)).toBe(6);
      expect(new TextDecoder().decode(fromStart)).toBe("outerr");
    } finally {
      host.nodeFs.closeSync(fd);
      await host.close();
    }
  });

  it("keeps a child numeric descriptor alive after the parent closes it", async () => {
    const host = harness(({ filesystem }) => {
      filesystem.write(1, bytes("child owns this"), null);
      return 0;
    });
    const path = "/work/owned.txt";
    const fd = host.nodeFs.openSync(path, "w");
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: ["ignore", fd, "ignore"],
      });
      const childClosed = closed(child);
      host.nodeFs.closeSync(fd);
      await childClosed;

      expect(host.nodeFs.readFileSync(path).toString()).toBe("child owns this");
    } finally {
      if (host.filesystem.descriptors.has(fd)) host.nodeFs.closeSync(fd);
      await host.close();
    }
  });

  it("keeps a numeric alias to parent fd zero when the child replaces fd zero with a pipe", async () => {
    const host = harness(({ filesystem }) => {
      filesystem.write(1, bytes("parent fd zero"), null);
      return 0;
    });
    const path = "/work/fd-zero.txt";
    const fd = host.nodeFs.openSync(path, "w");
    host.filesystem.descriptors.put(0, host.filesystem.descriptors.take(fd));
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: ["pipe", 0, "ignore"],
      });
      await closed(child);

      expect(host.nodeFs.readFileSync(path).toString()).toBe("parent fd zero");
      expect(host.nodeFs.fstatSync(0).isFile()).toBe(true);
    } finally {
      host.nodeFs.closeSync(0);
      await host.close();
    }
  });

  it("rejects a closed numeric descriptor before admission and releases prepared pipes", async () => {
    const host = harness(() => 0);
    const fd = host.nodeFs.openSync("/work/closed.txt", "w");
    host.nodeFs.closeSync(fd);
    const parentFds = [...host.filesystem.descriptors.entries()].map(([number]) => number);
    try {
      const child = host.childProcess.spawn("/bin/stdio-tool", {
        stdio: ["pipe", fd, "pipe"],
      });
      const childClosed = closed(child);
      const error = spawnError(child);
      await expect(error).resolves.toMatchObject({ code: "EBADF" });
      await childClosed;

      expect(child.pid).toBeUndefined();
      expect(host.programHost.processes.size).toBe(0);
      expect(host.wakes.size).toBe(0);
      expect([...host.filesystem.descriptors.entries()].map(([number]) => number)).toEqual(
        parentFds,
      );
    } finally {
      await host.close();
    }
  });

  it("checks closed numeric sources before allocating low-fd aliases", async () => {
    const stdio = [
      { readInto: () => 0 },
      { write: (source: Uint8Array) => source.byteLength },
      { write: (source: Uint8Array) => source.byteLength },
    ] as const satisfies readonly [WasiStdio, WasiStdio, WasiStdio];
    const host = harness(() => 0, stdio);
    host.nodeFs.closeSync(3);
    const parentFds = [...host.filesystem.descriptors.entries()].map(([number]) => number);
    try {
      expect(parentFds).toEqual([0, 1, 2]);
      const child = host.childProcess.spawn("/bin/stdio-tool", { stdio: [0, 3, 3] });
      const childClosed = closed(child);
      const outcome = await new Promise<Error | "spawn">((resolve) => {
        child.once("error", resolve);
        child.once("spawn", () => resolve("spawn"));
      });
      if (outcome === "spawn") await childClosed;

      expect(outcome).toMatchObject({ code: "EBADF" });
      expect(child.pid).toBeUndefined();
      expect(host.programHost.processes.size).toBe(0);
      expect(host.wakes.size).toBe(0);
      expect([...host.filesystem.descriptors.entries()].map(([number]) => number)).toEqual(
        parentFds,
      );
    } finally {
      await host.close();
    }
  });

  it("returns null sync outputs for ignored streams and keeps piped stderr", async () => {
    const host = harness(({ filesystem }) => {
      const input = new Uint8Array(8);
      expect(filesystem.read(0, input, null)).toBe(0);
      filesystem.write(1, bytes("discard"), null);
      filesystem.write(2, bytes("kept"), null);
      return 0;
    });
    try {
      const result = host.childProcess.spawnSync("/bin/stdio-tool", {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBeNull();
      expect(result.stderr).toBe("kept");
      expect(result.output).toEqual([null, null, "kept"]);
      expect(
        host.childProcess.execFileSync("/bin/stdio-tool", {
          stdio: ["ignore", "ignore", "ignore"],
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      await host.close();
    }
  });
});
