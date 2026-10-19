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

const constant = (value: number) => [65, ...leb(value, true)];
const name = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];

/** Reports the Nimbus result, needed word and output tail through real WASI stdout. */
export function nimbusCapacityCommand(importName: string, args: readonly number[], out: number) {
  const remaining = Math.min(64, 65_536 - out);
  const vectors = new Uint8Array(24);
  const view = new DataView(vectors.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 32, true);
  view.setUint32(12, 4, true);
  view.setUint32(16, out, true);
  view.setUint32(20, remaining, true);
  const segment = (pointer: number, bytes: number[]) => [
    0,
    ...constant(pointer),
    11,
    ...leb(bytes.length),
    ...bytes,
  ];
  const body = [
    0,
    ...constant(0),
    ...args.flatMap(constant),
    16,
    0,
    54,
    2,
    0,
    ...[1, 64, 3, 16].flatMap(constant),
    16,
    1,
    26,
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
        96,
        args.length,
        ...Array<number>(args.length).fill(127),
        1,
        127,
        96,
        4,
        127,
        127,
        127,
        127,
        1,
        127,
        96,
        0,
        0,
      ]),
      ...section(2, [
        2,
        ...name("nimbus_proc"),
        ...name(importName),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_write"),
        0,
        1,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 2]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [
        3,
        ...segment(32, [0xa5, 0xa5, 0xa5, 0xa5]),
        ...segment(64, [...vectors]),
        ...segment(out, Array<number>(remaining).fill(0xa5)),
      ]),
    ]),
  );
}
