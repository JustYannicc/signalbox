import * as NodeStream from "node:stream";

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

export function detachedProcessFixture(route: "kernel" | "computer") {
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
  const exits = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const descendantCloses = new Map<string, Promise<void>>();
  const calls = new Map<
    string,
    { args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
  >();
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
        context.filesystem.write(1, new TextEncoder().encode(`out:${name}\n`), null);
        context.filesystem.write(2, new TextEncoder().encode(`err:${name}\n`), null);
        members.set(name, context.identity.pid);
        calls.set(name, { args: context.args, cwd: context.filesystem.cwd, env: context.env });
        const exit = Promise.withResolvers<void>();
        exits.set(name, exit);
        context.signal.addEventListener(
          "abort",
          () => {
            signals.add(name);
            exit.resolve();
          },
          { once: true },
        );
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
          const done = closed(child);
          childCloses.push(done);
          descendantCloses.set(name === "leader" ? "child" : "grandchild", done);
        }
        if (name === "grandchild") entered.resolve();
        await Promise.race([finished.promise, exit.promise]);
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
    calls,
    finish(name: string) {
      const exit = exits.get(name);
      if (!exit) throw new Error(`Process has not entered: ${name}`);
      exit.resolve();
    },
    descendantClosed(name: string) {
      const done = descendantCloses.get(name);
      if (!done) throw new Error(`Descendant has not started: ${name}`);
      return done;
    },
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
