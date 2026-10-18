// @effect-diagnostics nodeBuiltinImport:off - an isolated Node process observes unhandled rejections without contaminating the test runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import { expect, it } from "@effect/vitest";

it("handles started async work when CPU leave fails in imports and async or inline program launch", () => {
  const kernelUrl = new URL("./", import.meta.url).href;
  const result = NodeChildProcess.spawnSync(
    NodeProcess.execPath,
    [
      "--input-type=module",
      "-e",
      `import { setImmediate } from "node:timers/promises";
import { KernelCpuAccounting } from "${kernelUrl}KernelCpuAccounting.ts";
import { KernelCpuExecution, runCurrentKernelCpuAsyncSystemImport } from "${kernelUrl}KernelCpuExecution.ts";
import { KernelProgramHost } from "${kernelUrl}KernelProgramHost.ts";
import { KernelProgramRegistry, KernelWakeRegistry, callKernel, ABI_VERSION } from "${kernelUrl}KernelAbi.ts";
import { KernelFileSystem } from "${kernelUrl}KernelFileSystem.ts";
import { createFacetSqliteStorage } from "${kernelUrl}FacetSqliteStorage.ts";
import { sqliteFixture } from "${kernelUrl}tests/sqliteFixture.ts";
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e)));
const results = [];
for (const scenario of ["import", "program", "inline"]) {
  let fail = false;
  const expected = new Error("clock-" + scenario);
  const accounting = new KernelCpuAccounting(() => {
    if (fail) {
      fail = false;
      throw expected;
    }
    return 10n;
  });
  if (scenario === "import") {
    const execution = new KernelCpuExecution(accounting);
    let received;
    await execution.root.run(async () => {
      const leave = execution.root.enterUser();
      try {
        await runCurrentKernelCpuAsyncSystemImport(() => {
          fail = true;
          return Promise.reject(new Error("operation-" + scenario));
        });
      } catch (e) {
        received = e;
      } finally {
        leave();
      }
    });
    execution.root.stop();
    results.push({ scenario, clockPreserved: received === expected });
  } else {
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 10n) }] });
    const registry = new KernelProgramRegistry();
    const manifest = { name: "fail", version: "1", abiVersion: ABI_VERSION, requiredCapabilities: ["process.wait"], entrypoint: "fail" };
    registry.register(manifest);
    const operation = () => {
      fail = true;
      return Promise.reject(new Error("operation-" + scenario));
    };
    const implementation = scenario === "inline"
      ? {kind: "javascript", runInline: operation}
      : {kind: "async", run: operation};
    const programs = new Map([["/bin/fail", {manifest, implementation}]]);
    const host = new KernelProgramHost({ registry, programs, wakes: new KernelWakeRegistry(), cpuAccounting: accounting });
    try {
      const prepared = host.prepare({ filesystem });
      const resolved = host.resolve("/bin/fail");
      if (resolved.status !== "ok") throw new Error("resolution");
      if (scenario === "inline") {
        let received;
        try {
          host.cpuExecution.root.run(() => host.runInline(prepared, resolved.value, [], {}));
        } catch(error) {received = error;}
        finally {await prepared.release();host.cpuExecution.root.stop();}
        results.push({scenario, clockPreserved: received === expected});
      } else {
        const child = callKernel(host.backend(prepared), "process.spawn", { program: resolved.value, args: [], env: {} });
        if (child.status !== "ok") throw new Error("admission");
        const status = await host.exitStatus(child.value);
        results.push({ scenario, status });
      }
    } finally {
      await host.processes.dispose();
      host.wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  }
}
await setImmediate();
console.log(JSON.stringify({ results, unhandled }));
if (unhandled.length) process.exitCode = 1;
`,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    results: [
      { scenario: "import", clockPreserved: true },
      {
        scenario: "program",
        status: {
          status: "error",
          error: { code: "IO_ERROR", message: "Child process completion failed" },
        },
      },
      { scenario: "inline", clockPreserved: true },
    ],
    unhandled: [],
  });
});
