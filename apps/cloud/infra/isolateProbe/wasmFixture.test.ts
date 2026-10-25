import { describe, expect, it } from "@effect/vitest";

import { JSPI_WASM, JSPI_WASM_METADATA } from "./wasmFixture.ts";

describe("JSPI WASM fixture", () => {
  it("declares just the suspending callback and synchronous continuation", () => {
    expect(WebAssembly.validate(JSPI_WASM)).toBe(true);
    const module = new WebAssembly.Module(JSPI_WASM);
    expect(WebAssembly.Module.imports(module)).toEqual([
      { module: "env", name: "suspend", kind: "function" },
    ]);
    expect(WebAssembly.Module.exports(module)).toEqual([{ name: "run", kind: "function" }]);
  });

  it("executes the addition after the imported callback, using the callback result", () => {
    const inputs: number[] = [];
    const instance = new WebAssembly.Instance(new WebAssembly.Module(JSPI_WASM), {
      env: {
        suspend: (value: number) => {
          inputs.push(value);
          return value + 1;
        },
      },
    });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("Missing WASM run export");
    expect(run(JSPI_WASM_METADATA.input)).toBe(JSPI_WASM_METADATA.expected);
    expect(run(5)).toBe(7);
    expect(inputs).toEqual([40, 5]);
  });
});
