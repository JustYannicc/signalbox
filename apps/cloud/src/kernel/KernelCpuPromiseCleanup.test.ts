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
import { KernelCpuExecution, runCurrentKernelCpuAsyncSystemImport, runCurrentKernelCpuAwaitableSystemImport } from "${kernelUrl}KernelCpuExecution.ts";
import { AgentOsDescriptorHost } from "${kernelUrl}AgentOsDescriptorHost.ts";
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
for (const operation of ["fd_dup2", "proc_closefrom"]) {
  for (const [phase, outcome] of [["step", "resolve"], ["step", "reject"], ["wrapper", "resolve"], ["wrapper", "reject"], ["repeated", "resolve"], ["repeated", "reject"], ["cleanup", "resolve"], ["cleanup", "reject"]]) {
    if (operation === "proc_closefrom" && phase === "cleanup") continue;
    const scenario = operation + "-" + phase + "-" + outcome;
    const expected = new Error("clock-" + scenario);
    let fail = 0;
    let repeat = phase === "repeated";
    let clockError = expected;
    const execution = new KernelCpuExecution(new KernelCpuAccounting(() => {
      if (fail && --fail === 0) {
        const error = clockError;
        if (repeat) {
          repeat = false;
          fail = 1;
          clockError = new Error("second clock failure");
        }
        throw error;
      }
      return 10n;
    }));
    const filesystem = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const host = new AgentOsDescriptorHost({ memory: () => memory, descriptors: filesystem.descriptors, wakes, asyncMode: true });
    const gate = Promise.withResolvers();
    const cleanupGate = Promise.withResolvers();
    const cleanupStarted = Promise.withResolvers();
    let sourceCloses = 0;
    let targetCloses = 0;
    let backendFinished = false;
    let settled = false;
    let settledBeforeCleanup = false;
    let followerCloses = 0;
    const spec = { kind: "stdio", offset: 0n, rightsBase: 0n, rightsInheriting: 0n, flags: 0 };
    const source = filesystem.descriptors.allocate({ ...spec, onLastClose: () => {
      sourceCloses++;
      if (phase === "cleanup") { cleanupStarted.resolve(); return cleanupGate.promise; }
    } });
    const target = filesystem.descriptors.allocate({ ...spec, onLastClose: () => {
      targetCloses++;
      fail = phase === "wrapper" ? 2 : 1;
      return gate.promise.finally(() => { backendFinished = true; });
    } });
    filesystem.descriptors.allocate({ ...spec, onLastClose: () => { followerCloses++; } });
    let received;
    try {
      const pending = execution.root.run(async () => {
        const leave = execution.root.enterUser();
        try {
          await runCurrentKernelCpuAwaitableSystemImport(() => operation === "fd_dup2"
            ? host.imports.fd_dup2(source, target) : host.imports.proc_closefrom(target));
        } catch (error) { received = error; }
        finally { leave(); }
      });
      const observed = pending.then(() => { settled = true; });
      await setImmediate();
      const settledBeforeBackend = settled;
      if (phase === "cleanup") {
        const replacement = filesystem.descriptors.allocate(spec);
        if (await host.imports.fd_dup2(replacement, source) !== 0) throw new Error("source replacement");
      }
      if (outcome === "resolve") gate.resolve();
      else gate.reject(new Error("operation-" + scenario));
      if (phase === "cleanup") {
        await cleanupStarted.promise;
        settledBeforeCleanup = settled;
        cleanupGate.reject(new Error("cleanup-" + scenario));
      }
      await observed;
      const followerAtResponse = followerCloses;
      const failedTargetPresent = filesystem.descriptors.has(target);
      const reused = await host.imports.fd_dup2(source, target);
      const closed = await host.imports.proc_closefrom(source);
      results.push({ scenario, clockPreserved: received === expected, settledBeforeBackend, settledBeforeCleanup, backendFinished, failedTargetPresent, followerAtResponse, followerCloses, reused, closed, sourceCloses, targetCloses, targetRemaining: filesystem.descriptors.has(target) });
    } finally {
      execution.root.stop();
      filesystem.dispose();
      wakes.dispose();
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
      ...["fd_dup2", "proc_closefrom"]
        .flatMap((operation) =>
          [
            "step-resolve",
            "step-reject",
            "wrapper-resolve",
            "wrapper-reject",
            "repeated-resolve",
            "repeated-reject",
            ...(operation === "fd_dup2" ? ["cleanup-resolve", "cleanup-reject"] : []),
          ].map((suffix) => operation + "-" + suffix),
        )
        .map((scenario) => ({
          scenario,
          clockPreserved: true,
          settledBeforeBackend: false,
          settledBeforeCleanup: false,
          followerAtResponse: 0,
          followerCloses: 1,
          backendFinished: true,
          failedTargetPresent: false,
          reused: 0,
          closed: 0,
          sourceCloses: 1,
          targetCloses: 1,
          targetRemaining: false,
        })),
    ],
    unhandled: [],
  });
});
