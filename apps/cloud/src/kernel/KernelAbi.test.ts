import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelResourceTable,
  KernelWakeRegistry,
  SUPPORTED_ABI_VERSIONS,
  attemptKernelOperation,
  callKernel,
  kernelOk,
  negotiateAbiVersion,
  type KernelBackend,
  type KernelResult,
  type RegisteredProgram,
  type ResolvedProgram,
} from "./KernelAbi.ts";
import { runKernelAbiProof } from "./KernelAbiProof.ts";

function ok<T>(result: KernelResult<T>): T {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected success");
  return result.value;
}

const program: RegisteredProgram = {
  name: "tool",
  version: "1.2.3",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.wait"],
  entrypoint: "tool-1.2.3",
};

describe("kernel host extension ABI", () => {
  it("runs the portable proof cases", async () => {
    const proof = await runKernelAbiProof();
    expect(proof.ok, JSON.stringify(proof.checks)).toBe(true);
    expect(proof.checks).toHaveLength(4);
  });

  it("negotiates only defined versions, including when a future version is offered first", () => {
    expect(ok(negotiateAbiVersion([99, ABI_VERSION]))).toBe(ABI_VERSION);
    expect(SUPPORTED_ABI_VERSIONS).toEqual([ABI_VERSION]);
    expect(negotiateAbiVersion([0])).toMatchObject({
      status: "error",
      error: { code: "ABI_MISMATCH" },
    });
    expect(negotiateAbiVersion([])).toMatchObject({
      status: "error",
      error: { code: "ABI_MISMATCH" },
    });
  });

  it("keeps resource capabilities table-local and rejects wrong kinds and stale identities", () => {
    const resources = new KernelResourceTable();
    const otherRequest = new KernelResourceTable();
    const child = { terminate: vi.fn() };
    const handle = ok(resources.allocate("process", child));
    expect(resources.get(handle, "process")).toEqual(kernelOk(child));
    expect(resources.get(handle, "secret")).toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
    expect(otherRequest.get(handle, "process")).toMatchObject({ status: "error" });
    expect(ok(resources.take(handle, "process"))).toBe(child);
    const replacement = ok(resources.allocate("process", child));
    expect(replacement.id).not.toBe(handle.id);
    expect(resources.get(handle, "process")).toMatchObject({ status: "error" });
    expect(child.terminate).not.toHaveBeenCalled();
  });

  it("bounds resource allocation without invalidating live capabilities", () => {
    const resources = new KernelResourceTable(1);
    const handle = ok(resources.allocate("secret", "opaque-reference"));
    expect(resources.allocate("resource", {})).toMatchObject({
      status: "error",
      error: { code: "RESOURCE_LIMIT" },
    });
    expect(ok(resources.take(handle, "secret"))).toBe("opaque-reference");
    expect(resources.allocate("resource", {})).toMatchObject({ status: "ok" });
  });

  it("preserves synchronous calls and asynchronously suspended process results", async () => {
    const processHandle = { kind: "process", id: "test-child" } as const;
    const backend: KernelBackend = {
      escalate: () => kernelOk({ requestId: "request-1" }),
      "process.wait": async () => kernelOk({ exitCode: 7 }),
    };
    expect(
      callKernel(backend, "escalate", { reason: "native binary", capability: "machine" }),
    ).toEqual(kernelOk({ requestId: "request-1" }));
    await expect(callKernel(backend, "process.wait", { handle: processHandle })).resolves.toEqual(
      kernelOk({ exitCode: 7 }),
    );
  });

  it("turns thrown and rejected backend failures into explicit errors", async () => {
    const backend: KernelBackend = {
      escalate: () => {
        throw new Error("private backend detail");
      },
      "process.wait": () => Promise.reject(new Error("private backend detail")),
    };
    expect(callKernel(backend, "escalate", { reason: "test", capability: "test" })).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    await expect(
      callKernel(backend, "process.wait", { handle: { kind: "process", id: "child" } }),
    ).resolves.toMatchObject({ status: "error", error: { code: "IO_ERROR" } });
  });

  it("pins versions, snapshots registration, and rejects duplicates and unsupported ABIs", () => {
    const programs = new KernelProgramRegistry();
    const requirements: RegisteredProgram["requiredCapabilities"][number][] = ["process.wait"];
    const mutable = { ...program, requiredCapabilities: requirements };
    ok(programs.register(mutable));
    mutable.entrypoint = "changed";
    requirements.push("escalate");
    const resolved = ok(
      programs.resolve(program.name, program.version, [ABI_VERSION], {
        "process.wait": () => kernelOk({ exitCode: 0 }),
      }),
    );
    expect(resolved.entrypoint).toBe(program.entrypoint);
    expect(resolved.requiredCapabilities).toEqual(["process.wait"]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(programs.register(program)).toMatchObject({
      status: "error",
      error: { code: "ALREADY_EXISTS" },
    });
    expect(programs.register({ ...program, version: "other", abiVersion: 0 })).toMatchObject({
      status: "error",
      error: { code: "ABI_MISMATCH" },
    });
    expect(programs.register({ ...program, version: " " })).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("requires registry resolution before spawning and rechecks capabilities at execution", async () => {
    const programs = new KernelProgramRegistry();
    ok(programs.register(program));
    const spawn = vi.fn(() => kernelOk({ kind: "process", id: "child" } as const));
    const backend: KernelBackend = {
      "process.spawn": spawn,
      "process.wait": () => kernelOk({ exitCode: 0 }),
    };
    const input = { args: [], env: {} };
    // An external caller cannot grant itself authority by copying a program manifest.
    expect(
      callKernel(backend, "process.spawn", { ...input, program: program as ResolvedProgram }),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    const resolved = ok(programs.resolve(program.name, program.version, [ABI_VERSION], backend));
    expect(await callKernel(backend, "process.spawn", { ...input, program: resolved })).toEqual(
      kernelOk({ kind: "process", id: "child" }),
    );
    expect(
      callKernel({ "process.spawn": spawn }, "process.spawn", { ...input, program: resolved }),
    ).toMatchObject({ status: "error", error: { code: "UNSUPPORTED" } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds program versions as well as names", () => {
    const programs = new KernelProgramRegistry(1);
    ok(programs.register(program));
    expect(programs.register({ ...program, version: "2.0.0" })).toMatchObject({
      status: "error",
      error: { code: "RESOURCE_LIMIT" },
    });
  });
});

describe("one-shot wake tokens", () => {
  const registries: KernelWakeRegistry[] = [];
  const registry = (options?: ConstructorParameters<typeof KernelWakeRegistry>[0]) => {
    const wakes = new KernelWakeRegistry(options);
    registries.push(wakes);
    return wakes;
  };
  afterEach(() => {
    for (const wakes of registries.splice(0)) wakes.dispose();
    vi.useRealTimers();
  });

  it("retains a synchronous wake during subscription and detaches exactly once", async () => {
    const wakes = registry();
    const detach = vi.fn();
    const token = ok(
      wakes.register((notify) => {
        notify();
        return detach;
      }),
    );
    expect(detach).toHaveBeenCalledTimes(1);
    expect(wakes.signal(token)).toBe(false);
    await expect(wakes.wait(token)).resolves.toEqual(kernelOk(undefined));
    await expect(wakes.wait(token)).resolves.toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
    expect(wakes.size).toBe(0);
  });

  it("subscribes before attempting I/O and releases immediate successes and failures", () => {
    const wakes = registry();
    const detach = vi.fn();
    let subscribed = false;
    expect(
      attemptKernelOperation(
        wakes,
        () => {
          subscribed = true;
          return detach;
        },
        () => {
          expect(subscribed).toBe(true);
          return kernelOk(42);
        },
      ),
    ).toEqual(kernelOk(42));
    expect(wakes.size).toBe(0);
    expect(
      attemptKernelOperation(
        wakes,
        () => detach,
        () => {
          throw new Error("failed");
        },
      ),
    ).toMatchObject({ status: "error", error: { code: "IO_ERROR" } });
    expect(detach).toHaveBeenCalledTimes(2);
    expect(wakes.size).toBe(0);
  });

  it("delivers one completion to one waiter and rejects concurrent consumers", async () => {
    const wakes = registry();
    const token = ok(wakes.register(() => () => {}));
    const waiting = wakes.wait(token);
    await expect(wakes.wait(token)).resolves.toMatchObject({
      status: "error",
      error: { code: "ALREADY_WAITING" },
    });
    expect(wakes.signal(token)).toBe(true);
    expect(wakes.cancel(token)).toBe(false);
    await expect(waiting).resolves.toEqual(kernelOk(undefined));
  });

  it("retains cancellation before wait and handles an already-aborted request", async () => {
    const wakes = registry();
    const token = ok(wakes.register(() => () => {}));
    expect(wakes.cancel(token)).toBe(true);
    await expect(wakes.wait(token)).resolves.toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
    const aborted = new AbortController();
    aborted.abort();
    const other = ok(wakes.register(() => () => {}));
    await expect(wakes.wait(other, aborted.signal)).resolves.toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
    expect(wakes.size).toBe(0);
  });

  it("expires both waiting and abandoned completed notifications without evicting live tokens", async () => {
    vi.useFakeTimers();
    const wakes = registry({ maxTokens: 2, ttlMs: 50 });
    const detach = vi.fn();
    const pending = ok(wakes.register(() => detach));
    const completed = ok(
      wakes.register((notify) => {
        notify();
        return detach;
      }),
    );
    const waiting = wakes.wait(pending);
    expect(wakes.register(() => detach)).toMatchObject({
      status: "error",
      error: { code: "RESOURCE_LIMIT" },
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(waiting).resolves.toMatchObject({ status: "error", error: { code: "EXPIRED" } });
    await expect(wakes.wait(completed)).resolves.toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
    expect(wakes.size).toBe(0);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(wakes.register(() => detach)).toMatchObject({ status: "ok" });
  });

  it("isolates tokens across requests and disposes pending waiters despite broken cleanup", async () => {
    const wakes = registry();
    const foreign = registry();
    const token = ok(
      wakes.register(() => () => {
        throw new Error("cleanup failed");
      }),
    );
    expect(foreign.signal(token)).toBe(false);
    const waiting = wakes.wait(token);
    wakes.dispose();
    await expect(waiting).resolves.toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(wakes.size).toBe(0);
    expect(wakes.register(() => () => {})).toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
  });

  it("rolls back failed subscription setup without retaining a timer", () => {
    vi.useFakeTimers();
    const wakes = registry();
    expect(
      wakes.register(() => {
        throw new Error("subscription failed");
      }),
    ).toMatchObject({ status: "error", error: { code: "IO_ERROR" } });
    expect(wakes.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hand out an invalid token when subscription setup disposes the request", () => {
    const wakes = registry();
    const detach = vi.fn();
    expect(
      wakes.register(() => {
        wakes.dispose();
        return detach;
      }),
    ).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(wakes.size).toBe(0);
  });
});
