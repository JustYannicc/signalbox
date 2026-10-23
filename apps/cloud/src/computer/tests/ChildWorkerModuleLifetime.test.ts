import { describe, expect, it, vi } from "vite-plus/test";
import { createChildWorkerProgram, type ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("child program module lifetime", () => {
  it("shares module bytes without copying them at registration or dispatch", async () => {
    const f = childBusyboxFixture();
    const wasm = new ArrayBuffer(8);
    const copy = vi.spyOn(wasm, "slice");
    const run = vi.fn(async (input: ChildWorkerInvocation) => {
      expect(input.modules["program.wasm"]).toEqual({ wasm });
      expect(input.modules["program.wasm"]).toHaveProperty("wasm", wasm);
      const module = input.modules["program.wasm"];
      if (typeof module !== "object" || module === null || !("wasm" in module)) {
        throw new Error("Missing WASM module");
      }
      expect(module.wasm).toBe(wasm);
      return exited();
    });
    try {
      const program = createChildWorkerProgram({
        executable: "/bin/program",
        code: {
          mainModule: "main.js",
          modules: () => ({ "program.wasm": { wasm } }),
        },
        capacity: new ChildWorkerCapacity(10),
        dispatch: { run },
        createHost: () => ({ host: {}, close() {} }),
      });
      expect(copy).not.toHaveBeenCalled();
      await program.run(f.context);
      expect(copy).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it("loads and freezes a fresh module map for each dispatch before capacity acquisition", async () => {
    const f = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    let loadCount = 0;
    const loadModules = vi.fn(async () => {
      expect(capacity.active).toBe(0);
      loadCount += 1;
      return { "entry.js": `export default ${loadCount}` };
    });
    const run = vi.fn(async (input: ChildWorkerInvocation) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.modules)).toBe(true);
      expect(input.modules["entry.js"]).toBe(`export default ${run.mock.calls.length}`);
      return exited();
    });
    try {
      const program = createChildWorkerProgram({
        executable: "/bin/program",
        code: { mainModule: "entry.js", modules: loadModules },
        capacity,
        dispatch: { run },
        createHost: () => ({ host: {}, close() {} }),
      });

      expect(loadModules).not.toHaveBeenCalled();
      await program.run(f.context);
      await program.run(f.context);

      expect(loadModules).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(2);
      expect(capacity.active).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("fails module preparation before creating the host, reserving capacity, or dispatching", async () => {
    const f = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(10);
    const failure = new Error("module source unavailable");
    const createHost = vi.fn(() => ({ host: {}, close() {} }));
    const run = vi.fn(async () => exited());
    try {
      const program = createChildWorkerProgram({
        executable: "/bin/program",
        code: {
          mainModule: "entry.js",
          modules: async () => {
            throw failure;
          },
        },
        capacity,
        dispatch: { run },
        createHost,
      });

      await expect(program.run(f.context)).rejects.toBe(failure);
      expect(createHost).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("rechecks cancellation after a pending module load before host creation", async () => {
    const f = childBusyboxFixture();
    const started = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<Readonly<Record<string, string>>>();
    const capacity = new ChildWorkerCapacity(10);
    const createHost = vi.fn(() => ({ host: {}, close() {} }));
    const run = vi.fn(async () => exited());
    try {
      const program = createChildWorkerProgram({
        executable: "/bin/program",
        code: {
          mainModule: "entry.js",
          modules: () => {
            started.resolve();
            return loaded.promise;
          },
        },
        capacity,
        dispatch: { run },
        createHost,
      });
      const pending = program.run(f.context);
      await started.promise;
      const cancellation = new Error("cancelled while loading");
      f.controller.abort(cancellation);
      loaded.resolve({ "entry.js": "export default 0" });

      await expect(pending).rejects.toBe(cancellation);
      expect(createHost).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      loaded.resolve({ "entry.js": "export default 0" });
      await f.close();
    }
  });

  it("preserves compiled module and host registry reference identity", async () => {
    const f = childBusyboxFixture();
    const compiled = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const modules = {
      "compiled.wasm": { wasm: compiled },
      "registry.wasm": { wasmReference: "sha256:module-key" },
    };
    const run = vi.fn(async (input: ChildWorkerInvocation) => {
      expect(input.modules["compiled.wasm"]).toEqual({ wasm: compiled });
      expect(input.modules["registry.wasm"]).toEqual({ wasmReference: "sha256:module-key" });
      const compiledModule = input.modules["compiled.wasm"];
      if (!compiledModule || typeof compiledModule === "string" || !("wasm" in compiledModule)) {
        throw new Error("Compiled WASM module missing");
      }
      expect(compiledModule.wasm).toBe(compiled);
      expect(Object.isFrozen(compiledModule)).toBe(true);
      return exited();
    });
    try {
      const program = createChildWorkerProgram({
        executable: "/bin/program",
        code: { mainModule: "main.js", modules },
        capacity: new ChildWorkerCapacity(10),
        dispatch: { run },
        createHost: () => ({ host: {}, close() {} }),
      });
      await program.run(f.context);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
});
