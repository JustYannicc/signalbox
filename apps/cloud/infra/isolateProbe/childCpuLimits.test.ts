import { describe, expect, it, vi } from "vite-plus/test";
import { RpcTarget } from "cloudflare:workers";
import { ChildWorkerDispatch, childWorkerDispatchBinding } from "./childWorkerDispatch.ts";
import { CodeGeneration, codeGenerationBinding } from "./codeGeneration.ts";
import { ChildWorkerDispatchError } from "../../src/computer/ChildWorkerDispatchError.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import {
  createChildWorkerProgram,
  type ChildWorkerCode,
  type ChildWorkerModules,
} from "../../src/computer/ChildWorkerProgram.ts";
import {
  createWorkerLoaderDispatch,
  type ChildWorkerLoaderPort,
} from "../../src/computer/WorkerLoaderDispatch.ts";
import type { ChildWorkerLimits } from "../../src/computer/ChildWorkerLimits.ts";
import type { KernelAsyncProgramContext } from "../../src/kernel/KernelAsyncProgram.ts";

const bindings = vi.hoisted(() => ({ child: vi.fn(), generated: vi.fn() }));
const wasmRegistry = vi.hoisted(() => {
  const reference = "c".repeat(64);
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return { reference, module, modules: new Map([[reference, module]]) };
});

vi.mock("cloudflare:workers", () => ({
  RpcTarget: Object,
  WorkerEntrypoint: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  exports: { ChildWorkerDispatch: bindings.child, CodeGeneration: bindings.generated },
}));
vi.mock("./programWasmRegistry.ts", () => ({
  CHILD_PROGRAM_WASM_REGISTRY: wasmRegistry.modules,
}));

class Host extends RpcTarget {
  readonly identity = "host";
}

function fixture(limits?: ChildWorkerLimits) {
  const codes: Array<WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>> = [];
  const target = {
    run: vi.fn().mockResolvedValue({ exitCode: 0, signal: 0, coreDumped: false }),
    open: vi.fn().mockResolvedValue({ marker: "managed invocation" }),
    fetch: vi.fn().mockResolvedValue(new Response("generated result")),
  };
  const getEntrypoint = vi.fn().mockReturnValue(target);
  const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, factory) => {
    codes.push(factory());
    return { getEntrypoint, getDurableObjectClass: vi.fn() };
  });
  const env = { LOADER: { get, load: vi.fn() } };
  const ctx = {
    props: { namespace: "stable namespace", limits },
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
  return {
    ctx,
    codes,
    get,
    getEntrypoint,
    target,
    child: new ChildWorkerDispatch(ctx, env),
    generated: new CodeGeneration(ctx, env),
  };
}

const command = { executable: "/bin/cat", argv: ["cat", "input"], cwd: "/work", env: {} };
const program = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
const envelope = { id: "input", ...program, input: { text: "unchanged input" } };
const exit = { exitCode: 0, signal: 0, coreDumped: false };

function request(value: unknown = envelope) {
  return new Request("https://code.invalid/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function alternateWasmBuffer() {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]);
  if (!WebAssembly.validate(bytes)) throw new Error("Invalid alternate WASM fixture");
  return bytes.buffer;
}

function composedProgramFixture(sourceKind: "static" | "lazy-factory") {
  const codes: WorkerLoaderWorkerCode[] = [];
  const host = new Host();
  const target = {
    run: vi.fn(async (_command: unknown, invocation: unknown) => {
      const capability = invocation as { host(): Host; stopped(): void };
      expect(capability.host()).toBe(host);
      capability.stopped();
      return exit;
    }),
  };
  const getEntrypoint = vi.fn().mockReturnValue(target);
  const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, factory) => {
    const code = factory();
    if (code instanceof Promise) throw new Error("Unexpected async code factory");
    codes.push(code);
    return { getEntrypoint, getDurableObjectClass: vi.fn() };
  });
  const adapter = new ChildWorkerDispatch(
    {
      props: { namespace: "unused", limits: { cpuMs: 1_000 } },
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    },
    { LOADER: { get, load: vi.fn() } },
  );
  const dispatch = createWorkerLoaderDispatch<Host>(adapter as unknown as ChildWorkerLoaderPort);
  const context = {
    signal: new AbortController().signal,
    args: ["/bin/program"],
    filesystem: { cwd: "/work" },
    env: {},
    // Admission still binds ownership when dispatch uses a minimal kernel fixture.
    identity: { handle: {}, pid: 2 },
    processes: {
      info: () => ({ status: "ok", value: { pid: 2, parentPid: 1, processGroupId: 2 } }),
      lookupPid: () => ({ status: "error" }),
      workerOwner: () => ({ status: "ok", value: undefined }),
      setWorkerOwner: () => ({ status: "ok", value: undefined }),
    },
  } as unknown as KernelAsyncProgramContext;
  const close = vi.fn();

  return {
    codes,
    get,
    host,
    target,
    context,
    close,
    code(modules: ChildWorkerModules): ChildWorkerCode {
      return {
        mainModule: "main.js",
        modules: sourceKind === "static" ? modules : () => modules,
      };
    },
    createProgram(modules: ChildWorkerModules) {
      return createChildWorkerProgram({
        executable: "/bin/program",
        code: this.code(modules),
        capacity: new ChildWorkerCapacity(),
        dispatch,
        createHost: () => ({ host, close }),
      });
    },
  };
}

describe("host-selected child CPU limits", () => {
  it.each([
    { limits: undefined, expected: 300_000 },
    { limits: {}, expected: 300_000 },
    { limits: { cpuMs: 1_000 }, expected: 1_000 },
    { limits: { cpuMs: 600_000 }, expected: 600_000 },
  ])(
    "applies $expected to all child code and selected entrypoints",
    async ({ limits, expected }) => {
      const f = fixture(limits);
      const host = new Host();
      await f.child.run({ ...program, entrypoint: "Child", command }, host);
      await f.generated.fetch(request());
      await f.generated.open(JSON.stringify(envelope));
      const codes = await Promise.all(f.codes);
      expect(codes).toHaveLength(3);
      for (const code of codes) expect(code.limits).toEqual({ cpuMs: expected });
      expect(f.getEntrypoint.mock.calls).toEqual([
        ["Child", { limits: codes[0]?.limits }],
        [undefined, { limits: codes[1]?.limits }],
        ["ManagedInvocation", { limits: codes[2]?.limits }],
      ]);
      for (const [index, call] of f.getEntrypoint.mock.calls.entries()) {
        expect(call[1].limits).toBe(codes[index]?.limits);
      }
      expect(f.target.run).toHaveBeenCalledWith(command, host);
      expect(f.target.open).toHaveBeenCalledWith(envelope.input);
      expect(JSON.parse(f.target.fetch.mock.calls[0]?.[1].body)).toEqual(envelope.input);
    },
  );

  it.each([
    "null",
    "[]",
    '{"cpuMs":null}',
    '{"cpuMs":0}',
    '{"cpuMs":-1}',
    '{"cpuMs":1.5}',
    '{"cpuMs":"1000"}',
    '{"cpuMs":9007199254740992}',
  ])("rejects invalid host configuration %s before calling the loader", async (json) => {
    const limits = JSON.parse(json);
    const f = fixture(limits);
    await expect(f.child.run({ ...program, command }, new Host())).rejects.toThrow();
    await expect(f.generated.fetch(request())).rejects.toThrow();
    await expect(f.generated.open(JSON.stringify(envelope))).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(() => childWorkerDispatchBinding(limits)).toThrow();
    expect(() => codeGenerationBinding("namespace", limits)).toThrow();
  });

  it("keeps budget selection in host binding props and rejects extra generated envelope fields", async () => {
    const chosen = { cpuMs: 600_000 };
    childWorkerDispatchBinding(chosen);
    codeGenerationBinding("namespace", chosen);
    chosen.cpuMs = 1;
    expect(bindings.child).toHaveBeenLastCalledWith({ props: { limits: { cpuMs: 600_000 } } });
    expect(bindings.generated).toHaveBeenLastCalledWith({
      props: { namespace: "namespace", limits: { cpuMs: 600_000 } },
    });
    const f = fixture({ cpuMs: 1_000 });
    const untrusted = { ...program, command, limits: { cpuMs: 600_000 } };
    await f.child.run(untrusted, new Host());
    expect((await Promise.all(f.codes))[0]?.limits).toEqual({ cpuMs: 1_000 });
    const extra = { ...envelope, limits: { cpuMs: 600_000 } };
    expect((await f.generated.fetch(request(extra))).status).toBe(400);
    await expect(f.generated.open(JSON.stringify(extra))).rejects.toThrow("Expected");
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("keeps named loader identities distinct when only the host budget changes", async () => {
    const f = fixture({ cpuMs: 1_000 });
    await f.generated.fetch(request());
    await f.generated.open(JSON.stringify(envelope));
    f.ctx.props.limits = { cpuMs: 600_000 };
    await f.generated.fetch(request());
    await f.generated.open(JSON.stringify(envelope));
    const names = f.get.mock.calls.map(([name]) => name);
    expect(names[0]).not.toBe(names[2]);
    expect(names[1]).not.toBe(names[3]);
    expect((await Promise.all(f.codes)).map((code) => code.limits?.cpuMs)).toEqual([
      1_000, 1_000, 600_000, 600_000,
    ]);
  });

  it("preserves raw public probe targets while acknowledging registry preflight failures", async () => {
    const f = fixture();
    const host = new Host();
    await expect(f.child.run({ ...program, command }, host)).resolves.toEqual({
      exitCode: 0,
      signal: 0,
      coreDumped: false,
    });
    expect(f.target.run).toHaveBeenCalledWith(command, host);

    const completionHost = Object.assign(new Host(), { stopped: vi.fn() });
    await expect(
      f.child.run(
        {
          ...program,
          modules: { ...program.modules, "missing.wasm": { wasmReference: "a".repeat(64) } },
          command,
        },
        completionHost,
      ),
    ).rejects.toThrow("Unknown child WASM reference");
    expect(completionHost.stopped).toHaveBeenCalledOnce();
    expect(f.get).toHaveBeenCalledOnce();
  });

  it.each(["static", "lazy-factory"] as const)(
    "rejects declared unknown and malformed references before loading for %s modules",
    async (sourceKind) => {
      for (const reference of ["d".repeat(64), "not-a-sha256"]) {
        const f = composedProgramFixture(sourceKind);
        const module = { wasm: alternateWasmBuffer(), wasmReference: reference };
        const program = f.createProgram({
          "main.js": "export default {};",
          "program.wasm": module,
        });
        const expectedMessage =
          reference === "not-a-sha256"
            ? "Invalid child WASM reference"
            : "Unknown child WASM reference";

        await expect(program.run(f.context)).rejects.toMatchObject({
          code: "CHILD_EXECUTION_FAILED",
          message: expectedMessage,
          termination: { kind: "stopped" },
        });
        expect(f.get).not.toHaveBeenCalled();
        expect(f.target.run).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["static", "lazy-factory"] as const)(
    "resolves the registered module instead of raw bytes for %s modules",
    async (sourceKind) => {
      const f = composedProgramFixture(sourceKind);
      const rawBytes = alternateWasmBuffer();
      const program = f.createProgram({
        "main.js": "export default {};",
        "program.wasm": { wasm: rawBytes, wasmReference: wasmRegistry.reference },
      });

      await expect(program.run(f.context)).resolves.toEqual(exit);

      const resolved = f.codes[0]?.modules["program.wasm"];
      if (typeof resolved !== "object" || resolved === null || !("wasm" in resolved)) {
        throw new Error("Registered WASM module missing from loader input");
      }
      expect(resolved.wasm).toBe(wasmRegistry.module);
      expect(resolved.wasm).not.toBe(rawBytes);
      expect(f.get).toHaveBeenCalledOnce();
      expect(f.target.run).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it("carries the core capability through the public adapter and compiled loader preflight", async () => {
    let observedHost: Host | undefined;
    const target = {
      run: vi.fn(async (_command: unknown, invocation: unknown) => {
        const capability = invocation as { host(): Host; stopped(): void };
        observedHost = capability.host();
        capability.stopped();
        return { exitCode: 0, signal: 0, coreDumped: false };
      }),
    };
    const getEntrypoint = vi.fn().mockReturnValue(target);
    const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, factory) => {
      const code = factory();
      if (code instanceof Promise) throw new Error("Unexpected async code factory");
      codes.push(code);
      return { getEntrypoint, getDurableObjectClass: vi.fn() };
    });
    const codes: WorkerLoaderWorkerCode[] = [];
    const limits = { cpuMs: 1_000 };
    const adapter = new ChildWorkerDispatch(
      {
        props: { namespace: "unused", limits },
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      },
      { LOADER: { get, load: vi.fn() } },
    );
    const core = createWorkerLoaderDispatch<Host>(adapter as unknown as ChildWorkerLoaderPort);
    const rawHost = new Host();

    await expect(
      core.run(
        {
          ...program,
          command,
          limits: { cpuMs: 600_000 },
        },
        rawHost,
      ),
    ).resolves.toEqual(exit);

    expect(observedHost).toBe(rawHost);
    expect(get).toHaveBeenCalledOnce();
    expect(codes[0]?.limits).toEqual(limits);
    expect(getEntrypoint).toHaveBeenCalledWith(undefined, { limits: codes[0]?.limits });
    expect(target.run).toHaveBeenCalledOnce();

    let failure: unknown;
    try {
      await core.run(
        {
          ...program,
          modules: {
            ...program.modules,
            "missing.wasm": { wasmReference: "b".repeat(64) },
          },
          command,
          limits: { cpuMs: 600_000 },
        },
        rawHost,
      );
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(ChildWorkerDispatchError);
    expect(failure).toMatchObject({ code: "CHILD_EXECUTION_FAILED" });
    expect((failure as ChildWorkerDispatchError).termination).toEqual({ kind: "stopped" });
    expect(get).toHaveBeenCalledOnce();
    expect(target.run).toHaveBeenCalledOnce();
  });
});
