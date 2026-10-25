import { describe, expect, it, vi } from "vite-plus/test";
import { attachProgramReference } from "../childPrograms/runtime.ts";
import { createWorkerLoaderDispatch } from "../../src/computer/WorkerLoaderDispatch.ts";
import type { ChildWorkerInvocation } from "../../src/computer/ChildWorkerProgram.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { createProofChildLoader } from "./ChildLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = [
  { path: "/bin/bash", hash: KERNEL_BASH_ARTIFACT.sha256 },
  { path: "/bin/cat", hash: KERNEL_BUSYBOX_ARTIFACT.sha256 },
  { path: "/bin/rg", hash: KERNEL_RIPGREP_ARTIFACT.sha256 },
] as const;
const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const exit = { exitCode: 17, signal: 0, coreDumped: false };
const mainSource = "export default class Child {}";

async function invocation(program: (typeof programs)[number]): Promise<ChildWorkerInvocation> {
  const code = attachProgramReference(
    {
      mainModule: "entry.js",
      modules: { "entry.js": mainSource, "dependency.js": "export const same = true;" },
    },
    program.hash,
  );
  if (typeof code.modules !== "function") throw new Error("Expected pinned module factory");
  return {
    ...code,
    modules: await code.modules(),
    command: { executable: program.path, argv: [program.path], cwd: "/workspace", env: {} },
  };
}

function nativeLoader() {
  const codes: WorkerLoaderWorkerCode[] = [];
  const run = async (_command: unknown, target: unknown) => {
    if (
      !target ||
      typeof target !== "object" ||
      !("stopped" in target) ||
      typeof target.stopped !== "function"
    )
      throw new Error("Missing child completion target");
    await target.stopped();
    return exit;
  };
  // Comparing this concrete fake with Cloudflare's generic RPC returns triggers TS5115.
  const workerShape: object = {
    getEntrypoint(): object {
      return { run };
    },
    getDurableObjectClass() {
      throw new Error("Unexpected Durable Object lookup");
    },
  };
  const worker = workerShape as WorkerStub;
  const loader: WorkerLoader = {
    get(_name, factory) {
      const code = factory();
      if (code instanceof Promise) throw new Error("Expected owner-local module resolution");
      codes.push(code);
      return worker;
    },
    load() {
      throw new Error("Unexpected eager worker load");
    },
  };
  return { loader, codes };
}

describe("proof pinned child loader", () => {
  it.each(programs)("rejects the raw loader for $path before dispatch", async (program) => {
    const native = nativeLoader();
    await expect(
      createWorkerLoaderDispatch(native.loader).run(await invocation(program), {}),
    ).rejects.toThrow("Child WASM reference requires a compiled module registry");
    expect(native.codes).toHaveLength(0);
  });

  it("resolves each proof pin to the same compiled module at the native loader", async () => {
    const native = nativeLoader();
    const compiled = programs.map(() => new WebAssembly.Module(emptyWasm));
    const registry = new Map(programs.map((program, index) => [program.hash, compiled[index]!]));
    const loader = createProofChildLoader(native.loader, registry);
    registry.clear();
    expect(native.codes).toHaveLength(0);
    const dispatch = createWorkerLoaderDispatch(loader);
    for (const [index, program] of programs.entries()) {
      const input = await invocation(program);
      const modules = { ...input.modules };
      await expect(dispatch.run(input, {})).resolves.toEqual(exit);
      const code = native.codes[index];
      const wasm = code?.modules["program.wasm"];
      if (typeof wasm !== "object" || wasm === null) throw new Error("Missing native WASM module");
      expect(wasm.wasm).toBe(compiled[index]);
      expect(wasm.wasm).not.toBeInstanceOf(ArrayBuffer);
      expect(wasm).not.toHaveProperty("wasmReference");
      expect(code?.modules["entry.js"]).toBe(mainSource);
      expect(code?.modules["dependency.js"]).toBe(input.modules["dependency.js"]);
      expect(input.modules).toEqual(modules);
    }
    expect(native.codes).toHaveLength(3);
  });

  it("fails closed before native dispatch when the proof build has not supplied its static registry", async () => {
    const native = nativeLoader();
    const dispatch = createWorkerLoaderDispatch(createProofChildLoader(native.loader));
    await expect(dispatch.run(await invocation(programs[0]), {})).rejects.toThrow(
      "Unknown child WASM reference",
    );
    expect(native.codes).toHaveLength(0);
  });
});
