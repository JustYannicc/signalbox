type ValueType = "i32" | "i64";

function leb(value: number): number[] {
  const bytes: number[] = [];
  while (true) {
    const byte = value & 127;
    value >>>= 7;
    const done = value === 0;
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
}

function name(value: string) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
}

function section(id: number, content: number[]) {
  return [id, ...leb(content.length), ...content];
}

function type(params: readonly ValueType[], results: readonly ValueType[]) {
  const code = (value: ValueType) => (value === "i32" ? 127 : 126);
  return [
    96,
    ...leb(params.length),
    ...params.map(code),
    ...leb(results.length),
    ...results.map(code),
  ];
}

/** Small real guest used to call one preview1 import through the public WASI adapter. */
export function wasmImportReactor(
  namespace: string,
  importName: string,
  params: readonly ValueType[],
  results: readonly ValueType[] = [],
) {
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
      ...section(1, [1, ...type(params, results)]),
      ...section(2, [1, ...name(namespace), ...name(importName), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("run"), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}
