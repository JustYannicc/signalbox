const unsignedLeb = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return bytes;
};

const name = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...unsignedLeb(bytes.length), ...bytes];
};

const section = (id: number, bytes: number[]) => [id, ...unsignedLeb(bytes.length), ...bytes];

export const JSPI_WASM_METADATA = {
  moduleName: "suspend.wasm",
  importModule: "env",
  importName: "suspend",
  exportName: "run",
  input: 40,
  expected: 42,
  wat: `(module
  (import "env" "suspend" (func $suspend (param i32) (result i32)))
  (func (export "run") (param i32) (result i32)
    local.get 0
    call $suspend
    i32.const 1
    i32.add))`,
} as const;

// JSPI wraps the import/export in JavaScript; the binary needs no experimental opcodes.
const body = [0x00, 0x20, 0x00, 0x10, 0x00, 0x41, 0x01, 0x6a, 0x0b];

export const JSPI_WASM = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  ...section(1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]),
  ...section(2, [0x01, ...name("env"), ...name("suspend"), 0x00, 0x00]),
  ...section(3, [0x01, 0x00]),
  ...section(7, [0x01, ...name("run"), 0x00, 0x01]),
  ...section(10, [0x01, ...unsignedLeb(body.length), ...body]),
]);
