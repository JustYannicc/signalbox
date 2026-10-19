import { describe, expect, it, vi } from "vite-plus/test";
import { RpcTarget } from "cloudflare:workers";
import { ChildWorkerDispatch, childWorkerDispatchBinding } from "./childWorkerDispatch.ts";
import { CodeGeneration, codeGenerationBinding } from "./codeGeneration.ts";
import type { ChildWorkerLimits } from "../../src/computer/ChildWorkerLimits.ts";

const bindings = vi.hoisted(() => ({ child: vi.fn(), generated: vi.fn() }));

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

function request(value: unknown = envelope) {
  return new Request("https://code.invalid/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
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
});
