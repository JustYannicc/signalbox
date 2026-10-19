import { describe, expect, it, vi } from "vite-plus/test";
import { createCompiledChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import { createWorkerLoaderDispatch } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerModules } from "../ChildWorkerProgram.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const hash = "a".repeat(64);
const compiled = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const command = { executable: "/bin/tool", argv: ["tool"], cwd: "/work", env: {} };
const exit = { exitCode: 0, signal: 0, coreDumped: false };

function loader() {
  let code: WorkerLoaderWorkerCode | undefined;
  const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, factory) => {
    const value = factory();
    if (value instanceof Promise) throw new Error("Unexpected async code");
    code = value;
    const run = vi.fn(async (_command: unknown, target: { stopped(): Promise<void> }) => {
      await target.stopped();
      return exit;
    });
    return { getEntrypoint: vi.fn().mockReturnValue({ run }), getDurableObjectClass: vi.fn() };
  });
  return { native: { get, load: vi.fn() }, get, code: () => code };
}

function input(modules: ChildWorkerModules) {
  return {
    mainModule: "main.js",
    modules: { "main.js": "export default {}", ...modules },
    command,
  };
}

describe("module dispatch ownership", () => {
  it("passes a compiled module by identity through the direct loader", async () => {
    const f = loader();
    const dispatch = createWorkerLoaderDispatch(f.native);
    await expect(dispatch.run(input({ "program.wasm": { wasm: compiled } }), {})).resolves.toEqual(
      exit,
    );
    const module = f.code()?.modules["program.wasm"];
    if (typeof module !== "object" || module === null) throw new Error("Missing compiled module");
    expect(module.wasm).toBe(compiled);
  });

  it("rejects an unresolved reference before direct loader submission as physically stopped", async () => {
    const f = loader();
    const dispatch = createWorkerLoaderDispatch(f.native);
    await expect(
      dispatch.run(input({ "program.wasm": { wasmReference: hash } }), {}),
    ).rejects.toMatchObject({
      termination: { kind: "stopped" },
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects compiled WASM before RPC submission as physically stopped", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Unable to deserialize cloned data"));
    const dispatch = createWorkerLoaderDispatch({ run });
    await expect(
      dispatch.run(input({ "program.wasm": { wasm: compiled } }), {}),
    ).rejects.toMatchObject({
      termination: { kind: "stopped" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the actual private completion envelope across compiled-registry dispatch", async () => {
    const f = loader();
    const port = createCompiledChildWorkerLoader(f.native, new Map([[hash, compiled]]));
    const dispatch = createWorkerLoaderDispatch(port);
    await expect(
      dispatch.run(input({ "program.wasm": { wasmReference: hash } }), {}),
    ).resolves.toEqual(exit);
    const module = f.code()?.modules["program.wasm"];
    if (typeof module !== "object" || module === null) throw new Error("Missing compiled module");
    expect(module.wasm).toBe(compiled);
    await expect(
      dispatch.run(input({ "program.wasm": { wasmReference: "b".repeat(64) } }), {}),
    ).rejects.toMatchObject({
      termination: { kind: "stopped" },
    });
    expect(f.get).toHaveBeenCalledOnce();
  });
});
