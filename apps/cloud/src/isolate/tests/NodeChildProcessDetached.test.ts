import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import { createComputerCommands } from "../../computer/ComputerCommands.ts";
import { createNodeChildProcess, type NodeChildProcess } from "../NodeChildProcess.ts";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeProcess } from "../NodeProcess.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

function closed(child: NodeChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
}

function fixture(route: "kernel" | "computer") {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  filesystem.mkdir("/work");
  filesystem.chdir("/work");
  const registry = new KernelProgramRegistry();
  const entered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const signals = new Set<string>();
  const members = new Map<string, number>();
  const childCloses: Promise<void>[] = [];
  const manifest = {
    name: "bash-spawn",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.spawn"] as const,
    entrypoint: "bash-spawn",
  };
  registry.register(manifest);
  const binding: KernelProgramBinding = {
    manifest,
    implementation: {
      kind: "async",
      async run(context) {
        const name = context.args.at(-1)!;
        members.set(name, context.identity.pid);
        context.signal.addEventListener("abort", () => signals.add(name), { once: true });
        if (name === "leader" || name === "child") {
          const childProcess = createNodeChildProcess(host, {
            filesystem: context.filesystem,
            parent: context.identity.handle,
            env: context.env,
          });
          const child = childProcess.spawn(
            "/bin/bash",
            [name === "leader" ? "child" : "grandchild"],
            { stdio: "ignore" },
          );
          childCloses.push(closed(child));
        }
        if (name === "grandchild") entered.resolve();
        await finished.promise;
        return { exitCode: 0, signal: context.signal.aborted ? 15 : 0, coreDumped: false };
      },
    },
  };
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/bash", binding]]),
  });
  const computer = createComputerCommands({
    mode: "admitted",
    kernel: { host, filesystem },
    isolateKernel: { host, filesystem },
  });
  const fs = createNodeFs(filesystem).fs;
  const context = { filesystem, env: { PATH: "/bin", HOME: "/work" } };
  const childProcess =
    route === "kernel"
      ? createNodeChildProcess(host, context)
      : createNodeComputerChildProcess(host, context, computer);
  const process = createNodeProcess({
    filesystem,
    env: context.env,
    processes: host.processes,
    identity: {
      version: "v24.18.0",
      versions: { node: "24.18.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/work",
      tmpdir: "/tmp",
      pid: 1,
      ppid: 0,
      execPath: "/bin/node",
      argv0: "node",
      argv: ["node"],
    },
    streams: {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    },
  });
  return {
    host,
    childProcess,
    process,
    entered,
    finished,
    signals,
    members,
    fs,
    track(child: NodeChildProcess) {
      const done = closed(child);
      childCloses.push(done);
      return done;
    },
    async close() {
      finished.resolve();
      await Promise.all(childCloses);
      await host.processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

describe("detached Node children over the kernel process namespace", () => {
  it.each([
    ["kernel", "pipes"],
    ["kernel", "output-file"],
    ["computer", "pipes"],
    ["computer", "output-file"],
  ] as const)(
    "runs the retained Claude Bash spawn shape through %s with %s",
    async (route, output) => {
      const f = fixture(route);
      try {
        const sibling = f.childProcess.spawn("/bin/bash", ["sibling"], { stdio: "ignore" });
        const siblingClosed = f.track(sibling);
        const fd = output === "output-file" ? f.fs.openSync("/work/bash-output", "w+") : undefined;
        // Claude 2.1.303 release.js:10148/10150, SHA cddd2bc5: Bash sets detached and uses a shared output fd unless streaming.
        const options = {
          detached: true,
          cwd: "/work",
          env: { PATH: "/bin", SHELL: "/bin/bash", GIT_EDITOR: "true" },
          stdio: fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", fd, fd],
          windowsHide: true,
        };
        const child = f.childProcess.spawn("/bin/bash", ["-c", "-l", "leader"], options);
        if (fd !== undefined) f.fs.closeSync(fd);
        child.stdin?.end();
        child.stdout?.resume();
        child.stderr?.resume();
        const childClosed = f.track(child);
        await f.entered.promise;
        expect(child.pid).toBeDefined();
        expect(f.host.processes.lookupPid(sibling.pid!)).toMatchObject({
          status: "ok",
          value: { info: { processGroupId: 1 } },
        });
        for (const name of ["leader", "child", "grandchild"]) {
          const lookup = f.host.processes.lookupPid(f.members.get(name)!);
          expect(lookup).toMatchObject({
            status: "ok",
            value: { info: { processGroupId: child.pid } },
          });
        }
        expect(f.process.kill(-child.pid!, 0)).toBe(true);
        expect(f.signals.size).toBe(0);
        expect(f.process.kill(-child.pid!, "SIGTERM")).toBe(true);
        expect([...f.signals].sort()).toEqual(["child", "grandchild", "leader"]);
        f.finished.resolve();
        await Promise.all([childClosed, siblingClosed]);
      } finally {
        await f.close();
      }
    },
  );

  it("rejects a non-boolean detached flag before creating a process", async () => {
    const f = fixture("kernel");
    try {
      expect(() =>
        Reflect.apply(f.childProcess.spawn, undefined, ["/bin/bash", [], { detached: "true" }]),
      ).toThrow(TypeError);
      expect(f.host.processes.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("keeps inline synchronous detached execution explicitly unavailable", async () => {
    const f = fixture("kernel");
    try {
      expect(() => f.childProcess.spawnSync("/bin/bash", ["leader"], { detached: true })).toThrow(
        "detached",
      );
      expect(f.host.processes.size).toBe(0);
    } finally {
      await f.close();
    }
  });
});
