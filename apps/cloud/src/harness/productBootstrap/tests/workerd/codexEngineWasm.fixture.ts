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
  call(9, [...constant(offset), ...constant(bytes.length)]);

const READY_OFFSET = 0x2000;
const THREAD_OFFSET = 0x2100;
const TURN_OFFSET = 0x2500;
const SNAPSHOT_OFFSET = 0x3000;
const IOVEC = 0x1000;
const NREAD = 0x1008;
const NWRITTEN = 0x100c;
const INPUT_BYTE = 0x1010;
const SOCKET_FD = 0x1020;
const SENT = 0x1024;
const RECEIVED = 0x1028;
const REQUEST_OFFSET = 0x4000;
const HTTP_REQUEST_OFFSET = 0x6000;
const HTTP_RESPONSE_OFFSET = 0x8000;
const HTTP_RESPONSE_CAPACITY = 0x1000;
const MCP_URL_PREFIX = "https://harness-mcp.invalid/";
const MCP_HTTP_BODY = "native-executor-request";
const MCP_HTTP_PREFIX = "POST /";
const MCP_HTTP_SUFFIX = ` HTTP/1.1\r\nHost: harness-mcp.invalid\r\nContent-Type: text/plain\r\nContent-Length: ${MCP_HTTP_BODY.length}\r\nConnection: close\r\n\r\n${MCP_HTTP_BODY}`;
const MCP_URL_PREFIX_OFFSET = 0x3800;
const MCP_HTTP_SUFFIX_OFFSET = 0x3840;
const MCP_ADDRESS = "harness-mcp.invalid:443";
const MCP_ADDRESS_OFFSET = 0x3940;
const MCP_HOST = "harness-mcp.invalid";
const MCP_HOST_OFFSET = 0x3980;
const MAX_MCP_PATH_BYTES = 2048;

const localGet = (index: number) => [0x20, index];
const localSet = (index: number) => [0x21, index];
const load8 = (pointer: number) => [...constant(pointer), 0x2d, 0, 0];

/** A tiny WASI peer: bootstrap, thread load, native MCP HTTP, then one completed turn. */
export function codexEngineBytes(): Uint8Array {
  const ready = encoder.encode('{"jsonrpc":"2.0","method":"signalbox/ready"}\n');
  const thread = encoder.encode(
    '{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"product-native-session","sessionId":"product-native-session","forkedFromId":null,"preview":"","projectId":null,"ephemeral":false,"modelProvider":"openai","createdAt":1782622440,"updatedAt":1782622440,"status":{"type":"idle"},"path":"/home/codex/sessions/product-native-session.jsonl","cwd":"/workspace","cliVersion":"0.162.1","source":"exec","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.4","modelProvider":"openai","serviceTier":null,"cwd":"/workspace","instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"reasoningEffort":"medium"}}\n',
  );
  const turn = encoder.encode(
    '{"jsonrpc":"2.0","id":2,"result":{"turn":{"id":"product-turn","items":[],"status":"inProgress"}}}\n{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"product-native-session","turn":{"id":"product-turn","status":"completed","items":[],"error":null}}}\n',
  );
  const snapshot = encoder.encode(new TextDecoder().decode(thread).replace('"id":1,', '"id":3,'));
  const image = new Uint8Array(HTTP_REQUEST_OFFSET + encoder.encode(MCP_HTTP_PREFIX).length);
  image.set(ready, READY_OFFSET);
  image.set(thread, THREAD_OFFSET);
  image.set(turn, TURN_OFFSET);
  image.set(snapshot, SNAPSHOT_OFFSET);
  image.set(encoder.encode(MCP_URL_PREFIX), MCP_URL_PREFIX_OFFSET);
  image.set(encoder.encode(MCP_HTTP_PREFIX), HTTP_REQUEST_OFFSET);
  image.set(encoder.encode(MCP_HTTP_SUFFIX), MCP_HTTP_SUFFIX_OFFSET);
  image.set(encoder.encode(MCP_ADDRESS), MCP_ADDRESS_OFFSET);
  image.set(encoder.encode(MCP_HOST), MCP_HOST_OFFSET);

  const readLineBody = [
    1,
    1,
    0x7f,
    ...constant(0),
    ...localSet(1),
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
    0x45,
    0x0d,
    1,
    ...localGet(0),
    ...localGet(1),
    0x6a,
    ...load8(INPUT_BYTE),
    0x3a,
    0,
    0,
    ...load8(INPUT_BYTE),
    ...constant(10),
    0x46,
    0x0d,
    1,
    ...localGet(1),
    ...constant(1),
    0x6a,
    ...localSet(1),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...localGet(1),
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
  // Keep URL selection inside the guest: the value comes from the actual
  // thread/start or thread/resume configuration written to stdin.
  const findBody = [
    1,
    2,
    0x7f,
    ...constant(0),
    ...localSet(4),
    0x03,
    0x40,
    ...localGet(4),
    ...localGet(3),
    0x6a,
    ...localGet(1),
    0x4b,
    0x04,
    0x40,
    ...constant(-1),
    0x0f,
    0x0b,
    ...constant(0),
    ...localSet(5),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(5),
    ...localGet(3),
    0x4f,
    0x04,
    0x40,
    ...localGet(4),
    0x0f,
    0x0b,
    ...localGet(0),
    ...localGet(4),
    0x6a,
    ...localGet(5),
    0x6a,
    0x2d,
    0,
    0,
    ...localGet(2),
    ...localGet(5),
    0x6a,
    0x2d,
    0,
    0,
    0x47,
    0x0d,
    1,
    ...localGet(5),
    ...constant(1),
    0x6a,
    ...localSet(5),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...localGet(4),
    ...constant(1),
    0x6a,
    ...localSet(4),
    0x0c,
    0,
    0x0b,
    ...constant(-1),
    0x0b,
  ];
  // host_net is the same socket/TLS/HTTP import surface the native Codex
  // process uses; CodexImports routes this origin through the active MCP map.
  const mcpBody = [
    1,
    8,
    0x7f,
    ...call(10, [
      ...localGet(0),
      ...localGet(1),
      ...constant(MCP_URL_PREFIX_OFFSET),
      ...constant(encoder.encode(MCP_URL_PREFIX).length),
    ]),
    ...localSet(2),
    ...localGet(2),
    ...constant(0),
    0x48,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...localGet(2),
    ...constant(encoder.encode(MCP_URL_PREFIX).length),
    0x6a,
    ...localSet(3),
    ...constant(0),
    ...localSet(4),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(4),
    ...constant(MAX_MCP_PATH_BYTES),
    0x4f,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...localGet(0),
    ...localGet(3),
    0x6a,
    ...localGet(4),
    0x6a,
    0x2d,
    0,
    0,
    ...constant(34),
    0x46,
    0x0d,
    1,
    ...localGet(4),
    ...constant(1),
    0x6a,
    ...localSet(4),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...localGet(4),
    0x45,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...constant(0),
    ...localSet(5),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(5),
    ...localGet(4),
    0x4f,
    0x0d,
    1,
    ...constant(HTTP_REQUEST_OFFSET + encoder.encode(MCP_HTTP_PREFIX).length),
    ...localGet(5),
    0x6a,
    ...localGet(0),
    ...localGet(3),
    0x6a,
    ...localGet(5),
    0x6a,
    0x2d,
    0,
    0,
    0x3a,
    0,
    0,
    ...localGet(5),
    ...constant(1),
    0x6a,
    ...localSet(5),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...constant(0),
    ...localSet(5),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(5),
    ...constant(encoder.encode(MCP_HTTP_SUFFIX).length),
    0x4f,
    0x0d,
    1,
    ...constant(HTTP_REQUEST_OFFSET + encoder.encode(MCP_HTTP_PREFIX).length),
    ...localGet(4),
    0x6a,
    ...localGet(5),
    0x6a,
    ...constant(MCP_HTTP_SUFFIX_OFFSET),
    ...localGet(5),
    0x6a,
    0x2d,
    0,
    0,
    0x3a,
    0,
    0,
    ...localGet(5),
    ...constant(1),
    0x6a,
    ...localSet(5),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...constant(encoder.encode(MCP_HTTP_PREFIX).length + encoder.encode(MCP_HTTP_SUFFIX).length),
    ...localGet(4),
    0x6a,
    ...localSet(9),
    ...call(2, [...constant(1), ...constant(6), ...constant(0), ...constant(SOCKET_FD)]),
    ...localSet(7),
    ...localGet(7),
    ...constant(0),
    0x47,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...load(SOCKET_FD),
    ...localSet(6),
    ...call(3, [
      ...localGet(6),
      ...constant(MCP_ADDRESS_OFFSET),
      ...constant(encoder.encode(MCP_ADDRESS).length),
    ]),
    ...localSet(7),
    ...localGet(7),
    ...constant(0),
    0x47,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...call(4, [
      ...localGet(6),
      ...constant(MCP_HOST_OFFSET),
      ...constant(encoder.encode(MCP_HOST).length),
    ]),
    ...localSet(7),
    ...localGet(7),
    ...constant(0),
    0x47,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...call(5, [
      ...localGet(6),
      ...constant(HTTP_REQUEST_OFFSET),
      ...localGet(9),
      ...constant(0),
      ...constant(SENT),
    ]),
    ...localSet(7),
    ...localGet(7),
    ...constant(0),
    0x47,
    0x04,
    0x40,
    0x00,
    0x0b,
    0x02,
    0x40,
    0x03,
    0x40,
    ...call(6, [
      ...localGet(6),
      ...constant(HTTP_RESPONSE_OFFSET),
      ...constant(HTTP_RESPONSE_CAPACITY),
      ...constant(0),
      ...constant(RECEIVED),
    ]),
    ...localSet(7),
    ...localGet(7),
    ...constant(0),
    0x47,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...load(RECEIVED),
    0x45,
    0x0d,
    1,
    0x0c,
    0,
    0x0b,
    0x0b,
    ...call(7, [...localGet(6)]),
    0x1a,
    0x0b,
  ];
  const startBody = [
    1,
    1,
    0x7f,
    ...write(READY_OFFSET, ready),
    ...call(8, [...constant(REQUEST_OFFSET)]),
    0x1a,
    ...call(8, [...constant(REQUEST_OFFSET)]),
    0x21,
    0,
    ...call(11, [...constant(REQUEST_OFFSET), ...localGet(0)]),
    ...write(THREAD_OFFSET, thread),
    ...call(8, [...constant(REQUEST_OFFSET)]),
    0x1a,
    ...write(TURN_OFFSET, turn),
    ...call(8, [...constant(REQUEST_OFFSET)]),
    0x1a,
    ...write(SNAPSHOT_OFFSET, snapshot),
    ...call(8, [...constant(REQUEST_OFFSET)]),
    0x1a,
    0x0b,
  ];
  const functionType = (parameters: number[], results: number[]) => [
    0x60,
    ...leb(parameters.length),
    ...parameters,
    ...leb(results.length),
    ...results,
  ];
  const types = [
    8,
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([], []),
    ...functionType([0x7f, 0x7f], []),
    ...functionType([0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f], [0x7f]),
    ...functionType([0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
  ];
  const imports = [
    8,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_read"),
    0,
    0,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_write"),
    0,
    0,
    ...name("host_net"),
    ...name("net_socket"),
    0,
    0,
    ...name("host_net"),
    ...name("net_connect"),
    0,
    3,
    ...name("host_net"),
    ...name("net_tls_connect"),
    0,
    3,
    ...name("host_net"),
    ...name("net_send"),
    0,
    4,
    ...name("host_net"),
    ...name("net_recv"),
    0,
    4,
    ...name("host_net"),
    ...name("net_close"),
    0,
    5,
  ];
  const functions = [5, 6, 2, 7, 2, 1];
  const exports = [2, ...name("memory"), 2, 0, ...name("_start"), 0, 12];
  const codeBodies = [readLineBody, writeBody, findBody, mcpBody, startBody];
  const code = [codeBodies.length];
  for (const body of codeBodies) {
    code.push(...leb(body.length), ...body);
  }
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
