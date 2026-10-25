const encoder = new TextEncoder();

export function tscGuest(trap = false): WebAssembly.Module {
  const types = [
    ...type(["i32", "i32", "i32"], ["i32"]),
    ...type(["i32"], []),
    ...type(["i32", "i32", "i32", "i32"], ["i32"]),
    ...type(["i32"], ["i32"]),
    ...type([], ["i32"]),
  ];
  const imports = [
    ...name("ts_host"),
    ...name("fs"),
    0,
    0,
    ...name("ts_host"),
    ...name("fs_take"),
    0,
    1,
  ];
  const call = [
    1, 1, 0x7f, 0x20, 0, 0x20, 1, 0x20, 2, 0x10, 0, 0x21, 4, 0x20, 3, 0x10, 1, 0x20, 4, 0x0b,
  ];
  const input = [0, 0x41, ...leb(64, true), 0x0b];
  const run = trap ? [0, 0x00, 0x0b] : [0, 0x41, 7, 0x0b];
  const code = [
    3,
    ...leb(call.length),
    ...call,
    ...leb(input.length),
    ...input,
    ...leb(run.length),
    ...run,
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
      ...section(1, [5, ...types]),
      ...section(2, [2, ...imports]),
      ...section(3, [3, 2, 3, 4]),
      ...section(5, [1, 0, 1]),
      ...section(7, [
        4,
        ...name("memory"),
        2,
        0,
        ...name("call"),
        0,
        2,
        ...name("ts_input"),
        0,
        3,
        ...name("ts_run"),
        0,
        4,
      ]),
      ...section(10, code),
    ]),
  );
}

type ValueType = "i32";

function section(id: number, content: number[]) {
  return [id, ...leb(content.length), ...content];
}

function type(params: readonly ValueType[], results: readonly ValueType[]) {
  return [
    96,
    ...leb(params.length),
    ...params.map(() => 127),
    ...leb(results.length),
    ...results.map(() => 127),
  ];
}

function name(value: string) {
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
}

function leb(value: number, signed = false): number[] {
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining = signed ? remaining >> 7 : remaining >>> 7;
    const done = signed
      ? (remaining === 0 && (byte & 64) === 0) || (remaining === -1 && (byte & 64) !== 0)
      : remaining === 0;
    bytes.push(byte | (done ? 0 : 0x80));
    if (done) return bytes;
  }
}
