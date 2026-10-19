import { describe, expect, it } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry, kernelOk } from "./KernelAbi.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const exit = { exitCode: 0, signal: 0, coreDumped: false };

function setup() {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 1n) }],
  });
  filesystem.mkdir("/work");
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "guest-spawn-tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "guest-spawn-tool",
  };
  expect(registry.register(manifest).status).toBe("ok");
  const binding: KernelProgramBinding = {
    manifest,
    implementation: {
      kind: "javascript",
      runInline({ filesystem: child, args, env }) {
        child.write(1, new TextEncoder().encode(`${child.cwd}|${args[0]}|${env.VALUE}`), null);
        return 7;
      },
    },
  };
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/tool", binding]]),
  });
  let finishParent = () => {};
  const completion = new Promise<typeof exit>((resolve) => {
    finishParent = () => resolve(exit);
  });
  const parent = host.processes.spawn(
    undefined,
    () => ({ completion, signal: () => kernelOk(undefined) }),
    () => {},
  );
  if (parent.status !== "ok") throw new Error("Could not admit the parent");
  const abort = new AbortController();
  const input = { filesystem, parent: parent.value.handle, signal: abort.signal };
  const request: AgentOsSpawnRequest = {
    execPath: "/bin/tool",
    argv: ["custom-argv0"],
    env: { VALUE: "exact" },
    cwd: "/work",
    actions: [],
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
    pidPointer: 0,
  };
  return {
    host,
    filesystem,
    input,
    request,
    abort,
    async close() {
      finishParent();
      await host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      fixture.close();
    },
  };
}

describe("direct guest spawning", () => {
  it("keeps canonical launch values and borrowed fd ownership through file actions", async () => {
    const test = setup();
    const output = test.filesystem.open(
      "/output",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
    );
    try {
      const spawned = await test.host.spawn(test.input, {
        ...test.request,
        actions: [{ kind: "dup2", fd: 1, sourceFd: output, flags: 0, mode: 0 }],
      });
      if (spawned.status !== "ok") throw new Error("Could not spawn the guest child");
      expect(test.host.processes.info(spawned.value)).toMatchObject({
        status: "ok",
        value: { parentPid: 2 },
      });
      await expect(test.host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 7 },
      });
      expect(test.host.reap(spawned.value).status).toBe("ok");
      expect(test.filesystem.descriptors.has(output)).toBe(true);
      const bytes = new Uint8Array(128);
      const count = test.filesystem.read(output, bytes, 0n);
      expect(new TextDecoder().decode(bytes.subarray(0, count))).toBe("/work|custom-argv0|exact");
    } finally {
      await test.close();
    }
  });

  it("rejects unsupported attributes before launching or changing descriptors", async () => {
    const test = setup();
    const before = test.host.processes.size;
    try {
      await expect(
        test.host.spawn(test.input, {
          ...test.request,
          attributes: { ...test.request.attributes, flags: 4 },
        }),
      ).resolves.toMatchObject({ status: "error", error: { code: "UNSUPPORTED" } });
      expect(test.host.processes.size).toBe(before);
    } finally {
      await test.close();
    }
  });
});
