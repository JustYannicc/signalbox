const encoder = new TextEncoder();
export const READY_LINE = '{"jsonrpc":"2.0","method":"signalbox/ready"}\n';

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
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
}
function section(id: number, bytes: number[]) {
  return [id, ...leb(bytes.length), ...bytes];
}
const constant = (value: number) => [0x41, ...leb(value, true)];
const call = (index: number, args: number[]) => [...args.flatMap(constant), 0x10, index, 0x1a];

/** Real WASI reads echo bytes until EOF, so tests can interrupt a suspended fd_read. */
export function echoEngine(extraImport = false, exitAfterReady = false): WebAssembly.Module {
  const ready = encoder.encode(READY_LINE);
  const memory = new Uint8Array(128 + ready.length);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 2048, true);
  view.setUint32(4, 4096, true);
  view.setUint32(16, 128, true);
  view.setUint32(20, ready.length, true);
  memory.set(ready, 128);
  const echoBody = [
    0,
    ...call(1, [1, 16, 1, 12]),
    0x02,
    0x40,
    0x03,
    0x40,
    ...constant(4),
    ...constant(4096),
    0x36,
    2,
    0,
    ...constant(0),
    ...constant(0),
    ...constant(1),
    ...constant(8),
    0x10,
    0,
    0x0d,
    1,
    ...constant(8),
    0x28,
    2,
    0,
    0x45,
    0x0d,
    1,
    ...constant(4),
    ...constant(8),
    0x28,
    2,
    0,
    0x36,
    2,
    0,
    ...call(1, [1, 0, 1, 12]),
    0x0c,
    0,
    0x0b,
    0x0b,
    0x0b,
  ];
  const body = exitAfterReady ? [0, ...call(1, [1, 16, 1, 12]), 0x0b] : echoBody;
  const imports = [
    ...name("wasi_snapshot_preview1"),
    ...name("fd_read"),
    0,
    0,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_write"),
    0,
    0,
    ...(extraImport ? [...name("missing"), ...name("must_reject"), 0, 0] : []),
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
      ...section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
      ...section(2, [extraImport ? 3 : 2, ...imports]),
      ...section(3, [1, 1]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, extraImport ? 3 : 2]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(memory.length), ...memory]),
    ]),
  );
}

/** A tiny WASI fixture exits or traps without writing any readiness or stderr bytes. */
export function exitBeforeReadyEngine(exitCode?: number): WebAssembly.Module {
  const exits = exitCode !== undefined;
  const body = exits ? [0, ...constant(exitCode), 0x10, 0, 0x0b] : [0, 0x00, 0x0b];
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
      ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      ...(exits
        ? section(2, [1, ...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0, 0])
        : []),
      ...section(3, [1, 1]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, exits ? 1 : 0]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}
