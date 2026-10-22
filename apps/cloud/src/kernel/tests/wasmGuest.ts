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

export function wasmSignalMaskCommand(how: number, low: number, high: number) {
  const body = [
    0,
    ...[how, low, high, 32, 36].flatMap((value) => [65, ...leb(value, true)]),
    16,
    0,
    16,
    1,
    11,
  ];
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
        ...type(Array<ValueType>(5).fill("i32"), ["i32"]),
        ...type(["i32"], []),
        ...type([], []),
      ]),
      ...section(2, [
        2,
        ...name("host_process"),
        ...name("proc_signal_mask_v2"),
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

/** Spawn /bin/child and exit with the host's errno, without JS-level import mocks. */
export function wasmSpawnCommand(
  flags: number,
  maskLow: number,
  maskHigh: number,
  queryParentMask = false,
) {
  const path = [...new TextEncoder().encode("/bin/child")];
  const args = [0, path.length, 0, 0, 0, 0, 0, 0, 0, 0, flags, 0, 0, maskLow, maskHigh, 0, 64];
  const query = queryParentMask
    ? [
        ...[3, 0, 0, 96, 100].flatMap((value) => [65, ...leb(value, true)]),
        16,
        2,
        34,
        0,
        4,
        64,
        32,
        0,
        16,
        1,
        11,
      ]
    : [];
  const body = [
    1,
    1,
    127,
    ...query,
    ...args.flatMap((value, index) =>
      queryParentMask && (index === 13 || index === 14)
        ? [65, ...leb(index === 13 ? 96 : 100, true), 40, 2, 0]
        : [65, ...leb(value, true)],
    ),
    16,
    0,
    16,
    1,
    11,
  ];
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
        4,
        ...type(Array<ValueType>(17).fill("i32"), ["i32"]),
        ...type(["i32"], []),
        ...type([], []),
        ...type(Array<ValueType>(5).fill("i32"), ["i32"]),
      ]),
      ...section(2, [
        3,
        ...name("host_process"),
        ...name("proc_spawn_v3"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        1,
        ...name("host_process"),
        ...name("proc_signal_mask_v2"),
        0,
        3,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 3]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, 0, 65, 0, 11, ...leb(path.length), ...path]),
    ]),
  );
}

/** Write to stdout with optional SIGPIPE block and unblock operations. */
export function wasmSigpipeCommand(block: boolean, unblock: boolean): WebAssembly.Module {
  const constant = (value: number) => [0x41, ...leb(value, true)];
  const mask = (how: number) => [...[how, 4096, 0, 40, 44].flatMap(constant), 0x10, 0, 0x1a];
  const body = [
    0,
    ...(block ? mask(0) : []),
    ...[1, 0, 1, 12].flatMap(constant),
    0x10,
    1,
    ...(unblock ? mask(1) : []),
    0x10,
    2,
    0x0b,
  ];
  const data = [16, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 121];
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
      ...section(
        1,
        [
          4, 0x60, 5, 127, 127, 127, 127, 127, 1, 127, 0x60, 4, 127, 127, 127, 127, 1, 127, 0x60, 1,
          127, 0, 0x60, 0, 0,
        ],
      ),
      ...section(2, [
        3,
        ...name("host_process"),
        ...name("proc_signal_mask_v2"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_write"),
        0,
        1,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        2,
      ]),
      ...section(3, [1, 3]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 3]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(data.length), ...data]),
    ]),
  );
}
