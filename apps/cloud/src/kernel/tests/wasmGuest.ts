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

/** Compile a real guest at test setup; production fixtures are static modules. */
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

/** Spawn /bin/child and exit with the host's errno, without JS-level import mocks. */
export function wasmSpawnCommand(flags: number, maskLow: number, maskHigh: number) {
  const path = [...new TextEncoder().encode("/bin/child")];
  const args = [0, path.length, 0, 0, 0, 0, 0, 0, 0, 0, flags, 0, 0, maskLow, maskHigh, 0, 64];
  const body = [0, ...args.flatMap((value) => [65, ...leb(value, true)]), 16, 0, 16, 1, 11];
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
        ...type(Array<ValueType>(17).fill("i32"), ["i32"]),
        ...type(["i32"], []),
        ...type([], []),
      ]),
      ...section(2, [
        2,
        ...name("host_process"),
        ...name("proc_spawn_v3"),
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
      ...section(11, [1, 0, 65, 0, 11, ...leb(path.length), ...path]),
    ]),
  );
}
