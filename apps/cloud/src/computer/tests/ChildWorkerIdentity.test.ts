import { describe, expect, it } from "vite-plus/test";
import { childWorkerId } from "../ChildWorkerIdentity.ts";
import type { ChildWorkerModules } from "../ChildWorkerProgram.ts";

const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const policy = {
  compatibilityDate: "2026-10-19",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "main.js",
  globalOutbound: null,
  limits: { cpuMs: 300_000 },
} as const;
const modules = { "main.js": "export default class {}", "data.js": { js: "export const x=1" } };

const id = (input: ChildWorkerModules) => childWorkerId({ ...policy, modules: input });

describe("child Worker code identity", () => {
  it("hashes canonical module names and contents independently of insertion order", async () => {
    const first = await id(modules);
    expect(first).toMatch(/^child-v1:[a-f0-9]{64}$/);
    expect(await id(Object.fromEntries(Object.entries(modules).toReversed()))).toBe(first);
    expect(await id({ ...modules, "data.js": { js: "export const x=2" } })).not.toBe(first);
    expect(await id({ ...modules, "other.js": "export default 0" })).not.toBe(first);
    expect(await id({ "main.js": modules["main.js"] })).not.toBe(first);
  });

  it("includes compatibility, main module, selected entrypoint and CPU policy", async () => {
    const code = { ...policy, modules };
    const first = await childWorkerId(code);
    for (const changed of [
      { ...code, compatibilityDate: "2026-10-20" },
      { ...code, compatibilityFlags: [] },
      { ...code, mainModule: "data.js" },
      { ...code, limits: { cpuMs: 500 } },
    ]) {
      expect(await childWorkerId(changed)).not.toBe(first);
    }
    expect(await childWorkerId(code, "Other")).not.toBe(first);
  });

  it("hashes WASM bytes instead of buffer identity and detects changed code", async () => {
    const original = await id({ ...modules, "program.wasm": { wasm: emptyWasm.slice().buffer } });
    expect(await id({ ...modules, "program.wasm": { wasm: emptyWasm.slice().buffer } })).toBe(
      original,
    );
    const changed = new Uint8Array([...emptyWasm, 0, 2, 1, 120]);
    expect(await id({ ...modules, "program.wasm": { wasm: changed.buffer } })).not.toBe(original);
  });

  it("uses registry hashes across separately compiled copies of the same pinned code", async () => {
    const first = new WebAssembly.Module(emptyWasm);
    const second = new WebAssembly.Module(emptyWasm);
    const hash = "a".repeat(64);
    const code = (module: WebAssembly.Module) => ({
      ...policy,
      modules: { ...modules, "program.wasm": { wasm: module } },
    });
    const expected = await childWorkerId(code(first), undefined, new Map([[first, hash]]));
    expect(await childWorkerId(code(second), undefined, new Map([[second, hash]]))).toBe(expected);
    expect(
      await childWorkerId({
        ...policy,
        modules: { ...modules, "program.wasm": { wasmReference: hash } },
      }),
    ).toBe(expected);
    expect(
      await childWorkerId(code(second), undefined, new Map([[second, "b".repeat(64)]])),
    ).not.toBe(expected);
  });

  it("reuses an opaque compiled module without aliasing another module with identical exports", async () => {
    const first = new WebAssembly.Module(emptyWasm);
    const second = new WebAssembly.Module(emptyWasm);
    const code = (module: WebAssembly.Module) => ({ ...modules, "program.wasm": { wasm: module } });
    const expected = await id(code(first));
    expect(await id(code(first))).toBe(expected);
    expect(await id(code(second))).not.toBe(expected);
  });
});
