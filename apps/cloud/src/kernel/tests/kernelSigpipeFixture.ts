export function sigpipeCommand(block: boolean, unblock: boolean): WebAssembly.Module {
  const constant = (value: number) => [0x41, ...leb(value)];
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

function leb(value: number): number[] {
  const out: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    out.push(byte | (value ? 128 : 0));
  } while (value);
  return out;
}

function name(value: string) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
}

function section(id: number, bytes: readonly number[]) {
  return [id, ...leb(bytes.length), ...bytes];
}
