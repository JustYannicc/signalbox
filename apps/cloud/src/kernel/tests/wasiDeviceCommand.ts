/** A real preview1 command exits with the errno from opening dev/null. */
export function wasmDeviceOpenCommand(): WebAssembly.Module {
  const name = (value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [bytes.length, ...bytes];
  };
  // Every fixed section here is shorter than 128 bytes, so its length fits one LEB byte.
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [
    0, 0x41, 3, 0x41, 0, 0x41, 0, 0x41, 8, 0x41, 0, 0x42, 2, 0x42, 0, 0x41, 0, 0x41, 32, 0x10, 0,
    0x10, 1, 0x0b,
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
      ...section(
        1,
        [
          3, 0x60, 9, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f,
          0, 0x60, 0, 0,
        ],
      ),
      ...section(2, [
        2,
        ...name("wasi_snapshot_preview1"),
        ...name("path_open"),
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
      ...section(10, [1, body.length, ...body]),
      ...section(11, [1, 0, 0x41, 0, 0x0b, ...name("dev/null")]),
    ]),
  );
}
