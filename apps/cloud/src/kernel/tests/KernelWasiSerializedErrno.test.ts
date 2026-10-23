import { expect, it } from "vite-plus/test";
import { mapErrno } from "../wasi/internal_wasi_calls.ts";
import { WasiError } from "../wasi/internal_wasi_memory.ts";

it("reconstructs a serialized WASI errno from its standard Error message", () => {
  const serializedCode = structuredClone(
    Object.assign(new Error("quota rejected"), { code: "EAGAIN" }),
  ) as Error & { readonly code?: string };
  const serialized = structuredClone(new WasiError(6));

  expect(serializedCode.code).toBeUndefined();
  expect(serialized.name).toBe("Error");
  expect(serialized.message).toBe("WASI error: 6");
  expect("errno" in serialized).toBe(false);
  expect(() => mapErrno(serialized)).not.toThrow();
  expect(mapErrno(serialized)).toBe(6);
});
