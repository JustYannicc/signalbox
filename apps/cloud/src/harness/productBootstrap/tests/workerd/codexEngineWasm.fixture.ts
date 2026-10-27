const encoder = new TextEncoder();

function leb(value: number, signed = false): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value = signed ? value >> 7 : value >>> 7;
    const done = signed
      ? (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)
      : value === 0;
    bytes.push(byte | (done ? 0 : 0x80));
    if (done) return bytes;
  }
}

const name = (value: string) => {
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
const constant = (value: number) => [0x41, ...leb(value, true)];
const load = (pointer: number) => [...constant(pointer), 0x28, 2, 0];
const store = (pointer: number, value: number, offset = 0) => [
  ...constant(pointer),
  ...constant(value),
  0x36,
  2,
  offset,
];
const call = (index: number, args: number[]) => [...args, 0x10, index];
const write = (offset: number, bytes: Uint8Array) =>
  call(3, [...constant(offset), ...constant(bytes.length)]);

const READY_OFFSET = 0x2000;
const THREAD_OFFSET = 0x2100;
const TURN_OFFSET = 0x2500;
const SNAPSHOT_OFFSET = 0x3000;
const IOVEC = 0x1000;
const NREAD = 0x1008;
const NWRITTEN = 0x100c;
const INPUT_BYTE = 0x1010;

/** A tiny precompiled-at-load WASI peer: bootstrap, thread/start, then one completed turn. */
export function codexEngineBytes(): Uint8Array {
  const ready = encoder.encode('{"jsonrpc":"2.0","method":"signalbox/ready"}\n');
  const thread = encoder.encode(
    '{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"product-native-session","sessionId":"product-native-session","forkedFromId":null,"preview":"","projectId":null,"ephemeral":false,"modelProvider":"openai","createdAt":1782622440,"updatedAt":1782622440,"status":{"type":"idle"},"path":"/home/codex/sessions/product-native-session.jsonl","cwd":"/workspace","cliVersion":"0.162.1","source":"exec","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.4","modelProvider":"openai","serviceTier":null,"cwd":"/workspace","instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"reasoningEffort":"medium"}}\n',
  );
  const turn = encoder.encode(
    '{"jsonrpc":"2.0","id":2,"result":{"turn":{"id":"product-turn","items":[],"status":"inProgress"}}}\n{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"product-native-session","turn":{"id":"product-turn","status":"completed","items":[],"error":null}}}\n',
  );
  const snapshot = encoder.encode(new TextDecoder().decode(thread).replace('"id":1,', '"id":3,'));
  const image = new Uint8Array(SNAPSHOT_OFFSET + snapshot.length);
  image.set(ready, READY_OFFSET);
  image.set(thread, THREAD_OFFSET);
  image.set(turn, TURN_OFFSET);
  image.set(snapshot, SNAPSHOT_OFFSET);

  const readLineBody = [
    1,
    1,
    0x7f,
    0x02,
    0x40,
    0x03,
    0x40,
    ...store(IOVEC, INPUT_BYTE),
    ...store(IOVEC, 1, 4),
    ...constant(0),
    ...constant(IOVEC),
    ...constant(1),
    ...constant(NREAD),
    0x10,
    0,
    0x1a,
    ...load(NREAD),
    0x21,
    0,
    0x20,
    0,
    0x45,
    0x0d,
    1,
    ...constant(INPUT_BYTE),
    0x2d,
    0,
    0,
    ...constant(10),
    0x46,
    0x0d,
    1,
    0x0c,
    0,
    0x0b,
    0x0b,
    0x0b,
  ];
  const writeBody = [
    0,
    ...constant(IOVEC),
    0x20,
    0,
    0x36,
    2,
    0,
    ...constant(IOVEC),
    0x20,
    1,
    0x36,
    2,
    4,
    ...constant(1),
    ...constant(IOVEC),
    ...constant(1),
    ...constant(NWRITTEN),
    0x10,
    1,
    0x1a,
    0x0b,
  ];
  const startBody = [
    0,
    ...store(IOVEC, INPUT_BYTE),
    ...store(IOVEC, 1, 4),
    ...write(READY_OFFSET, ready),
    0x10,
    2,
    0x10,
    2,
    ...write(THREAD_OFFSET, thread),
    0x10,
    2,
    ...write(TURN_OFFSET, turn),
    0x10,
    2,
    ...write(SNAPSHOT_OFFSET, snapshot),
    0x10,
    2,
    0x0b,
  ];
  const types = [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0, 0x60, 2, 0x7f, 0x7f, 0];
  const imports = [
    2,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_read"),
    0,
    0,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_write"),
    0,
    0,
  ];
  const functions = [3, 1, 2, 1];
  const exports = [2, ...name("memory"), 2, 0, ...name("_start"), 0, 4];
  const code = [
    3,
    ...leb(readLineBody.length),
    ...readLineBody,
    ...leb(writeBody.length),
    ...writeBody,
    ...leb(startBody.length),
    ...startBody,
  ];
  const data = [1, 0, ...constant(0), 0x0b, ...leb(image.length), ...image];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, functions),
    ...section(5, [1, 0, 1]),
    ...section(7, exports),
    ...section(10, code),
    ...section(11, data),
  ]);
}
