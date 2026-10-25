type ValueType = "i32" | "i64";

function leb(value: number, signed = false): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 127;
    value = signed ? value >> 7 : value >>> 7;
    const done = signed
      ? (value === 0 && (byte & 64) === 0) || (value === -1 && (byte & 64) !== 0)
      : value === 0;
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
}

function name(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
}

function section(id: number, content: number[]): number[] {
  return [id, ...leb(content.length), ...content];
}

function functionType(params: readonly ValueType[], results: readonly ValueType[]): number[] {
  const code = (value: ValueType) => (value === "i32" ? 127 : 126);
  return [
    96,
    ...leb(params.length),
    ...params.map(code),
    ...leb(results.length),
    ...results.map(code),
  ];
}

/** Builds a tiny guest that calls one imported function and exports its memory. */
export function wasmImportReactor(
  namespace: string,
  importName: string,
  params: readonly ValueType[],
  results: readonly ValueType[] = [],
): WebAssembly.Module {
  const body = [0, ...params.flatMap((_, index) => [32, ...leb(index)]), 16, 0, 11];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, ...functionType(params, results)]),
      ...section(2, [1, ...name(namespace), ...name(importName), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("run"), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}

/** Builds a guest that returns the host's environ_get status as its process exit code. */
export function wasmEnvironmentGetCommand(): WebAssembly.Module {
  const body = [0, 65, ...leb(16, true), 65, ...leb(64, true), 16, 0, 16, 1, 11];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [
        3,
        ...functionType(["i32", "i32"], ["i32"]),
        ...functionType(["i32"], []),
        ...functionType([], []),
      ]),
      ...section(2, [
        2,
        ...name("wasi_snapshot_preview1"),
        ...name("environ_get"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        1,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 2]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}
