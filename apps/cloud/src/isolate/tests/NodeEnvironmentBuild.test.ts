// @effect-diagnostics nodeBuiltinImport:off - Checks exact installed package source and WASM bytes.
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import {
  buildNodeEnvironment,
  type NodeEnvironmentBuild,
  transformUndiciClientH1Source,
  UNDICI_WASM_IMPORTS,
} from "../NodeEnvironmentBuild.ts";

const cloudRequire = NodeModule.createRequire(import.meta.url);
const undiciRequire = NodeModule.createRequire(cloudRequire.resolve("undici"));
const clientH1Source = NodeFS.readFileSync(
  undiciRequire.resolve("./lib/dispatcher/client-h1.js"),
  "utf8",
);

let environmentBuild: NodeEnvironmentBuild;

beforeAll(async () => {
  environmentBuild = await buildNodeEnvironment();
});

describe("Node environment package build", () => {
  it("rewrites the pinned llhttp constructors to WorkerLoader wasm imports", () => {
    const source = transformUndiciClientH1Source(clientH1Source);

    expect(source).toContain(`import llhttpWasmSimd from "${UNDICI_WASM_IMPORTS.simd}";`);
    expect(source).toContain(`import llhttpWasmFallback from "${UNDICI_WASM_IMPORTS.fallback}";`);
    expect(source).toContain("mod = llhttpWasmSimd");
    expect(source).toContain("mod = llhttpWasmFallback");
    expect(source).not.toContain("new WebAssembly.Module");
    expect(source).not.toContain("llhttpWasmData");
    expect(source).toContain("return new WebAssembly.Instance(mod, {");
    expect(source).toContain("let llhttpInstance = null");
  });

  it("copies the exact installed undici llhttp binaries into startup wasm entries", () => {
    const actualSimd = Uint8Array.from(undiciRequire("./lib/llhttp/llhttp_simd-wasm.js"));
    const actualFallback = Uint8Array.from(undiciRequire("./lib/llhttp/llhttp-wasm.js"));
    const wasmByPath = new Map(
      environmentBuild.startupWasm.map(({ path, bytes }) => [path, bytes] as const),
    );

    expect(wasmByPath.get("node/environment/llhttp-simd.wasm")).toEqual(actualSimd);
    expect(wasmByPath.get("node/environment/llhttp.wasm")).toEqual(actualFallback);
  });

  it("fails closed when undici changes either llhttp constructor shape", () => {
    const changedSources = [
      clientH1Source.replace(
        "new WebAssembly.Module(require('../llhttp/llhttp_simd-wasm.js'))",
        "new WebAssembly.Module(require('../llhttp/unexpected-simd.wasm'))",
      ),
      clientH1Source.replace(
        "new WebAssembly.Module(llhttpWasmData || require('../llhttp/llhttp-wasm.js'))",
        "new WebAssembly.Module(llhttpWasmData || require('../llhttp/unexpected-fallback.wasm'))",
      ),
      clientH1Source.replace("process.env.JEST_WORKER_ID", "process.env.UNEXPECTED_WORKER_FLAG"),
    ];

    for (const changed of changedSources) {
      expect(changed).not.toBe(clientH1Source);
      expect(() => transformUndiciClientH1Source(changed)).toThrow(
        "unsupported undici llhttp source",
      );
    }
  });
});
