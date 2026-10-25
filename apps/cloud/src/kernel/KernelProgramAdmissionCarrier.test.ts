import { describe, expect, it } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  callKernel,
  kernelOk,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import {
  KernelProgramHost,
  type KernelAsyncProgram,
  type KernelProgramBinding,
} from "./KernelProgramHost.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const exit = (exitCode: number) => ({ exitCode, signal: 0, coreDumped: false });

function manifest(name: string): RegisteredProgram {
  return {
    name,
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: [],
    entrypoint: name,
  };
}

function asyncBinding(name: string, run: KernelAsyncProgram["run"]): KernelProgramBinding {
  return { manifest: manifest(name), implementation: { kind: "async", run } };
}

function setup(programs: ReadonlyMap<string, KernelProgramBinding>) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 1n) }],
  });
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  for (const binding of programs.values()) {
    if (registry.register(binding.manifest).status !== "ok") {
      throw new Error(`Program registration failed: ${binding.manifest.name}`);
    }
  }
  const host = new KernelProgramHost({ registry, wakes, programs });
  return {
    host,
    filesystem,
    wakes,
    fixture,
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      fixture.close();
    },
  };
}

function spawnRequest(execPath: string): AgentOsSpawnRequest {
  return {
    execPath,
    argv: [execPath],
    env: {},
    actions: [],
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
    pidPointer: 0,
  };
}

function spawnPrepared(
  host: KernelProgramHost,
  filesystem: KernelFileSystem,
  path: string,
  admission?: object,
): KernelHandle<"process"> {
  const resolved = host.resolve(path);
  if (resolved.status !== "ok") throw new Error(`Could not resolve ${path}`);
  const prepared = host.prepare({ filesystem, ...(admission === undefined ? {} : { admission }) });
  const spawned = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: [],
    env: {},
  });
  if (spawned.status !== "ok") throw new Error(`Could not spawn ${path}`);
  return spawned.value;
}

describe("KernelProgram admission carrier", () => {
  it("uses the prepared token for its async dispatch without passing it to a guest child", async () => {
    const rootToken = {};
    const grants = new WeakMap<object, string>([[rootToken, "root"]]);
    const childStarted = Promise.withResolvers<KernelHandle<"process">>();
    const continueRoot = Promise.withResolvers<void>();
    let childAdmission: object | undefined;
    const context = setup(
      new Map<string, KernelProgramBinding>([
        [
          "/bin/root",
          asyncBinding("root", async (program) => {
            if (program.admission === undefined || grants.get(program.admission) !== "root") {
              return exit(81);
            }
            const child = await program.spawn(spawnRequest("/bin/child"));
            if (child.status !== "ok") return exit(82);
            childStarted.resolve(child.value);
            await continueRoot.promise;
            return exit(0);
          }),
        ],
        [
          "/bin/child",
          asyncBinding("child", (program) => {
            childAdmission = program.admission;
            const role = childAdmission === undefined ? undefined : grants.get(childAdmission);
            return Promise.resolve(exit(role === undefined ? 0 : 83));
          }),
        ],
      ]),
    );
    try {
      const root = spawnPrepared(context.host, context.filesystem, "/bin/root", rootToken);
      const rootExit = context.host.exitStatus(root);
      const firstEvent = await Promise.race([
        childStarted.promise.then((child) => ({ child })),
        rootExit.then((result) => ({ result })),
      ]);
      if ("result" in firstEvent) {
        expect(firstEvent.result).toMatchObject({ status: "ok", value: { exitCode: 0 } });
        throw new Error("Root exited before spawning its child");
      }
      const child = firstEvent.child;
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 0 },
      });
      expect(childAdmission).toBeUndefined();
      continueRoot.resolve();
      await expect(rootExit).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 0 },
      });
      expect(context.host.reap(child).status).toBe("ok");
      expect(context.host.reap(root).status).toBe("ok");
    } finally {
      continueRoot.resolve();
      await context.close();
    }
  });

  it("uses the explicit direct Host.spawn token as the child's WeakMap grant", async () => {
    const directToken = {};
    const grants = new WeakMap<object, string>([[directToken, "direct"]]);
    const context = setup(
      new Map<string, KernelProgramBinding>([
        [
          "/bin/direct",
          asyncBinding("direct", (program) => {
            const role =
              program.admission === undefined ? undefined : grants.get(program.admission);
            return Promise.resolve(exit(role === "direct" ? 17 : 84));
          }),
        ],
      ]),
    );
    const parentCompletion = Promise.withResolvers<ReturnType<typeof exit>>();
    const parent = context.host.processes.spawn(
      undefined,
      () => ({ completion: parentCompletion.promise, signal: () => kernelOk(undefined) }),
      () => {},
    );
    if (parent.status !== "ok") throw new Error("Could not admit the Host.spawn parent");
    try {
      const spawned = await context.host.spawn(
        {
          filesystem: context.filesystem,
          parent: parent.value.handle,
          signal: new AbortController().signal,
          admission: directToken,
        },
        spawnRequest("/bin/direct"),
      );
      if (spawned.status !== "ok") throw new Error("Could not spawn the direct child");
      await expect(context.host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 17 },
      });
      expect(context.host.reap(spawned.value).status).toBe("ok");
    } finally {
      parentCompletion.resolve(exit(0));
      await context.close();
    }
  });

  it("uses each explicit exec token and does not inherit admission across replacement images", async () => {
    const rootToken = {};
    const execToken = {};
    const grants = new WeakMap<object, string>([
      [rootToken, "root"],
      [execToken, "exec"],
    ]);
    const pids: number[] = [];
    let rootAdmission: object | undefined;
    let replacementAdmission: object | undefined;
    let finalAdmission: object | undefined;
    const context = setup(
      new Map<string, KernelProgramBinding>([
        [
          "/bin/root",
          asyncBinding("root", async (program) => {
            rootAdmission = program.admission;
            pids.push(program.identity.pid);
            if (program.admission === undefined || grants.get(program.admission) !== "root") {
              return exit(85);
            }
            return program.exec({
              filesystem: program.filesystem,
              identity: program.identity,
              args: [],
              env: program.env,
              signal: program.signal,
              path: "/bin/replacement",
              admission: execToken,
            });
          }),
        ],
        [
          "/bin/replacement",
          asyncBinding("replacement", async (program) => {
            replacementAdmission = program.admission;
            pids.push(program.identity.pid);
            if (program.admission === undefined || grants.get(program.admission) !== "exec") {
              return exit(86);
            }
            return program.exec({
              filesystem: program.filesystem,
              identity: program.identity,
              args: [],
              env: program.env,
              signal: program.signal,
              path: "/bin/final",
            });
          }),
        ],
        [
          "/bin/final",
          asyncBinding("final", (program) => {
            finalAdmission = program.admission;
            pids.push(program.identity.pid);
            const role = finalAdmission === undefined ? undefined : grants.get(finalAdmission);
            return Promise.resolve(exit(role === undefined ? 0 : 87));
          }),
        ],
      ]),
    );
    try {
      const root = spawnPrepared(context.host, context.filesystem, "/bin/root", rootToken);
      await expect(context.host.exitStatus(root)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 0 },
      });
      expect(rootAdmission).toBe(rootToken);
      expect(replacementAdmission).toBe(execToken);
      expect(finalAdmission).toBeUndefined();
      expect(new Set(pids).size).toBe(1);
      expect(context.host.reap(root).status).toBe("ok");
    } finally {
      await context.close();
    }
  });
});
