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
const localGet = (index: number) => [0x20, index];
const localSet = (index: number) => [0x21, index];
const load8At = (address: number[]) => [...address, 0x2d, 0, 0];
const store32At = (pointer: number, value: number[]) => [
  ...constant(pointer),
  ...value,
  0x36,
  2,
  0,
];
const failIf = (condition: number[]) => [...condition, 0x04, 0x40, 0x00, 0x0b];
const copyLoop = (
  destination: number[],
  source: number[],
  length: number[],
  indexLocal: number,
) => [
  ...constant(0),
  ...localSet(indexLocal),
  0x02,
  0x40,
  0x03,
  0x40,
  ...localGet(indexLocal),
  ...length,
  0x4f,
  0x0d,
  1,
  ...destination,
  ...localGet(indexLocal),
  0x6a,
  ...source,
  ...localGet(indexLocal),
  0x6a,
  0x2d,
  0,
  0,
  0x3a,
  0,
  0,
  ...localGet(indexLocal),
  ...constant(1),
  0x6a,
  ...localSet(indexLocal),
  0x0c,
  0,
  0x0b,
  0x0b,
];

const READY_OFFSET = 0x2000;
const THREAD_RESULT_OFFSET = 0x2100;
const TURN_RESULT_OFFSET = 0x2500;
const TURN_COMPLETED_OFFSET = 0x2a00;
const IOVEC = 0x1000;
const NREAD = 0x1008;
const NWRITTEN = 0x100c;
const INPUT_BYTE = 0x1010;
const SOCKET_FD = 0x1020;
const SENT = 0x1024;
const RECEIVED = 0x1028;
const ID_START = 0x1030;
const ID_LENGTH = 0x1034;
const LATEST_MCP_PATH_LENGTH = 0x1038;
const LATEST_MCP_PATH = 0x1100;
const REQUEST_OFFSET = 0x4000;
const HTTP_REQUEST_OFFSET = 0x6000;
const HTTP_RESPONSE_OFFSET = 0x8000;
const HTTP_RESPONSE_CAPACITY = 0x1000;
const OUTPUT_OFFSET = 0xa000;
const MAX_LINE_BYTES = HTTP_REQUEST_OFFSET - REQUEST_OFFSET;
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
const METHOD_THREAD_START = '"method":"thread/start"';
const METHOD_THREAD_RESUME = '"method":"thread/resume"';
const METHOD_TURN_START = '"method":"turn/start"';
const METHOD_THREAD_READ = '"method":"thread/read"';
const ID_NEEDLE = '"id":';
const RPC_PREFIX = '{"jsonrpc":"2.0","id":';
const RPC_MID = ',"result":';
const RPC_SUFFIX = "}\n";
const TURN_COMPLETED =
  '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"product-native-session","turn":{"id":"product-turn","status":"completed","items":[],"error":null}}}\n';
const METHOD_THREAD_START_OFFSET = 0x3a00;
const METHOD_THREAD_RESUME_OFFSET = 0x3a40;
const METHOD_TURN_START_OFFSET = 0x3a80;
const METHOD_THREAD_READ_OFFSET = 0x3ac0;
const ID_NEEDLE_OFFSET = 0x3b00;
const RPC_PREFIX_OFFSET = 0x3b20;
const RPC_MID_OFFSET = 0x3b40;
const RPC_SUFFIX_OFFSET = 0x3b60;

/** A tiny line-oriented app-server peer; all request ids and MCP URLs come from stdin. */
export function codexEngineBytes(): Uint8Array {
  const ready = encoder.encode('{"jsonrpc":"2.0","method":"signalbox/ready"}\n');
  const threadFrame =
    '{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"product-native-session","sessionId":"product-native-session","forkedFromId":null,"preview":"","projectId":null,"ephemeral":false,"modelProvider":"openai","createdAt":1782622440,"updatedAt":1782622440,"status":{"type":"idle"},"path":"/home/codex/sessions/product-native-session.jsonl","cwd":"/workspace","cliVersion":"0.162.1","source":"exec","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.4","modelProvider":"openai","serviceTier":null,"cwd":"/workspace","instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"reasoningEffort":"medium"}}\n';
  const resultMarker = '"result":';
  const threadResultText = threadFrame.slice(
    threadFrame.indexOf(resultMarker) + resultMarker.length,
    -2,
  );
  const threadResult = encoder.encode(threadResultText);
  const turnResult = encoder.encode(
    '{"turn":{"id":"product-turn","items":[],"status":"inProgress"}}',
  );
  const turnCompleted = encoder.encode(TURN_COMPLETED);
  const methodThreadStart = encoder.encode(METHOD_THREAD_START);
  const methodThreadResume = encoder.encode(METHOD_THREAD_RESUME);
  const methodTurnStart = encoder.encode(METHOD_TURN_START);
  const methodThreadRead = encoder.encode(METHOD_THREAD_READ);
  const idNeedle = encoder.encode(ID_NEEDLE);
  const rpcPrefix = encoder.encode(RPC_PREFIX);
  const rpcMid = encoder.encode(RPC_MID);
  const rpcSuffix = encoder.encode(RPC_SUFFIX);
  const suffix = encoder.encode(MCP_HTTP_SUFFIX);
  const urlPrefix = encoder.encode(MCP_URL_PREFIX);
  const httpPrefix = encoder.encode(MCP_HTTP_PREFIX);
  const address = encoder.encode(MCP_ADDRESS);
  const host = encoder.encode(MCP_HOST);
  const image = new Uint8Array(
    Math.max(
      HTTP_REQUEST_OFFSET + httpPrefix.length,
      METHOD_THREAD_START_OFFSET + methodThreadStart.length,
      METHOD_THREAD_RESUME_OFFSET + methodThreadResume.length,
      METHOD_TURN_START_OFFSET + methodTurnStart.length,
      METHOD_THREAD_READ_OFFSET + methodThreadRead.length,
      ID_NEEDLE_OFFSET + idNeedle.length,
      RPC_PREFIX_OFFSET + rpcPrefix.length,
      RPC_MID_OFFSET + rpcMid.length,
      RPC_SUFFIX_OFFSET + rpcSuffix.length,
      TURN_COMPLETED_OFFSET + turnCompleted.length,
    ),
  );
  image.set(ready, READY_OFFSET);
  image.set(threadResult, THREAD_RESULT_OFFSET);
  image.set(turnResult, TURN_RESULT_OFFSET);
  image.set(turnCompleted, TURN_COMPLETED_OFFSET);
  image.set(urlPrefix, MCP_URL_PREFIX_OFFSET);
  image.set(httpPrefix, HTTP_REQUEST_OFFSET);
  image.set(suffix, MCP_HTTP_SUFFIX_OFFSET);
  image.set(address, MCP_ADDRESS_OFFSET);
  image.set(host, MCP_HOST_OFFSET);
  image.set(methodThreadStart, METHOD_THREAD_START_OFFSET);
  image.set(methodThreadResume, METHOD_THREAD_RESUME_OFFSET);
  image.set(methodTurnStart, METHOD_TURN_START_OFFSET);
  image.set(methodThreadRead, METHOD_THREAD_READ_OFFSET);
  image.set(idNeedle, ID_NEEDLE_OFFSET);
  image.set(rpcPrefix, RPC_PREFIX_OFFSET);
  image.set(rpcMid, RPC_MID_OFFSET);
  image.set(rpcSuffix, RPC_SUFFIX_OFFSET);

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
    ...localGet(1),
    ...constant(MAX_LINE_BYTES),
    0x4f,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...localGet(0),
    ...localGet(1),
    0x6a,
    ...load8At([...constant(INPUT_BYTE)]),
    0x3a,
    0,
    0,
    ...load8At([...constant(INPUT_BYTE)]),
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
  const parseIdBody = [
    1,
    3,
    0x7f,
    ...call(10, [
      ...localGet(0),
      ...localGet(1),
      ...constant(ID_NEEDLE_OFFSET),
      ...constant(idNeedle.length),
    ]),
    ...localSet(2),
    ...localGet(2),
    ...constant(0),
    0x48,
    0x04,
    0x40,
    ...constant(0),
    0x0f,
    0x0b,
    ...localGet(2),
    ...constant(idNeedle.length),
    0x6a,
    ...localSet(3),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(3),
    ...localGet(1),
    0x4f,
    0x0d,
    1,
    ...load8At([...localGet(0), ...localGet(3), 0x6a]),
    ...constant(32),
    0x47,
    0x0d,
    1,
    ...localGet(3),
    ...constant(1),
    0x6a,
    ...localSet(3),
    0x0c,
    0,
    0x0b,
    0x0b,
    ...localGet(3),
    ...localGet(1),
    0x4f,
    0x04,
    0x40,
    ...constant(0),
    0x0f,
    0x0b,
    ...load8At([...localGet(0), ...localGet(3), 0x6a]),
    ...constant(34),
    0x46,
    0x04,
    0x40,
    ...constant(1),
    ...localSet(4),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(3),
    ...localGet(4),
    0x6a,
    ...localGet(1),
    0x4f,
    0x04,
    0x40,
    ...constant(0),
    0x0f,
    0x0b,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
    ...constant(34),
    0x46,
    0x04,
    0x40,
    ...localGet(4),
    ...constant(1),
    0x6a,
    ...localSet(4),
    0x0c,
    2,
    0x0b,
    ...localGet(4),
    ...constant(1),
    0x6a,
    ...localSet(4),
    0x0c,
    0,
    0x0b,
    0x0b,
    0x05,
    ...constant(0),
    ...localSet(4),
    0x02,
    0x40,
    0x03,
    0x40,
    ...localGet(3),
    ...localGet(4),
    0x6a,
    ...localGet(1),
    0x4f,
    0x0d,
    1,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
    ...constant(44),
    0x46,
    0x0d,
    1,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
    ...constant(125),
    0x46,
    0x0d,
    1,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
    ...constant(32),
    0x46,
    0x0d,
    1,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
    ...constant(10),
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
    0x0b,
    ...localGet(4),
    0x45,
    0x04,
    0x40,
    ...constant(0),
    0x0f,
    0x0b,
    ...store32At(ID_START, [...localGet(0), ...localGet(3), 0x6a]),
    ...store32At(ID_LENGTH, [...localGet(4)]),
    ...constant(1),
    0x0b,
  ];
  const cacheMcpUrlBody = [
    1,
    4,
    0x7f,
    ...call(10, [
      ...localGet(0),
      ...localGet(1),
      ...constant(MCP_URL_PREFIX_OFFSET),
      ...constant(urlPrefix.length),
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
    ...constant(urlPrefix.length),
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
    ...localGet(3),
    ...localGet(4),
    0x6a,
    ...localGet(1),
    0x4f,
    0x04,
    0x40,
    0x00,
    0x0b,
    ...load8At([...localGet(0), ...localGet(3), 0x6a, ...localGet(4), 0x6a]),
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
    ...copyLoop(
      [...constant(LATEST_MCP_PATH)],
      [...localGet(0), ...localGet(3), 0x6a],
      [...localGet(4)],
      5,
    ),
    ...store32At(LATEST_MCP_PATH_LENGTH, [...localGet(4)]),
    0x0b,
  ];
  const mcpBody = [
    1,
    8,
    0x7f,
    ...failIf([...localGet(1), 0x45]),
    ...copyLoop(
      [...constant(HTTP_REQUEST_OFFSET + httpPrefix.length)],
      [...localGet(0)],
      [...localGet(1)],
      5,
    ),
    ...copyLoop(
      [...constant(HTTP_REQUEST_OFFSET + httpPrefix.length), ...localGet(1), 0x6a],
      [...constant(MCP_HTTP_SUFFIX_OFFSET)],
      [...constant(suffix.length)],
      5,
    ),
    ...constant(httpPrefix.length + suffix.length),
    ...localGet(1),
    0x6a,
    ...localSet(9),
    ...call(2, [...constant(1), ...constant(6), ...constant(0), ...constant(SOCKET_FD)]),
    ...localSet(7),
    ...failIf([...localGet(7), ...constant(0), 0x47]),
    ...load(SOCKET_FD),
    ...localSet(6),
    ...call(3, [...localGet(6), ...constant(MCP_ADDRESS_OFFSET), ...constant(address.length)]),
    ...localSet(7),
    ...failIf([...localGet(7), ...constant(0), 0x47]),
    ...call(4, [...localGet(6), ...constant(MCP_HOST_OFFSET), ...constant(host.length)]),
    ...localSet(7),
    ...failIf([...localGet(7), ...constant(0), 0x47]),
    ...call(5, [
      ...localGet(6),
      ...constant(HTTP_REQUEST_OFFSET),
      ...localGet(9),
      ...constant(0),
      ...constant(SENT),
    ]),
    ...localSet(7),
    ...failIf([...localGet(7), ...constant(0), 0x47]),
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
    ...failIf([...localGet(7), ...constant(0), 0x47]),
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
  const writeResponseBody = [
    1,
    2,
    0x7f,
    ...copyLoop(
      [...constant(OUTPUT_OFFSET)],
      [...constant(RPC_PREFIX_OFFSET)],
      [...constant(rpcPrefix.length)],
      4,
    ),
    ...copyLoop(
      [...constant(OUTPUT_OFFSET + rpcPrefix.length)],
      [...localGet(0)],
      [...localGet(1)],
      4,
    ),
    ...copyLoop(
      [...constant(OUTPUT_OFFSET + rpcPrefix.length), ...localGet(1), 0x6a],
      [...constant(RPC_MID_OFFSET)],
      [...constant(rpcMid.length)],
      4,
    ),
    ...copyLoop(
      [...constant(OUTPUT_OFFSET + rpcPrefix.length + rpcMid.length), ...localGet(1), 0x6a],
      [...localGet(2)],
      [...localGet(3)],
      4,
    ),
    ...copyLoop(
      [
        ...constant(OUTPUT_OFFSET + rpcPrefix.length + rpcMid.length),
        ...localGet(1),
        0x6a,
        ...localGet(3),
        0x6a,
      ],
      [...constant(RPC_SUFFIX_OFFSET)],
      [...constant(rpcSuffix.length)],
      4,
    ),
    ...constant(rpcPrefix.length + rpcMid.length + rpcSuffix.length),
    ...localGet(1),
    0x6a,
    ...localGet(3),
    0x6a,
    ...localSet(5),
    ...call(9, [...constant(OUTPUT_OFFSET), ...localGet(5)]),
    0x0b,
  ];
  const methodMatches = (offset: number, bytes: Uint8Array) => [
    ...call(10, [...localGet(0), ...localGet(1), ...constant(offset), ...constant(bytes.length)]),
    ...constant(0),
    0x4e,
  ];
  const writeResponse = (resultOffset: number, resultLength: number) =>
    call(14, [
      ...load(ID_START),
      ...load(ID_LENGTH),
      ...constant(resultOffset),
      ...constant(resultLength),
    ]);
  const dispatchBody = [
    0,
    ...call(11, [...localGet(0), ...localGet(1)]),
    0x45,
    0x04,
    0x40,
    0x0f,
    0x0b,
    ...methodMatches(METHOD_THREAD_START_OFFSET, methodThreadStart),
    0x04,
    0x40,
    ...call(12, [...localGet(0), ...localGet(1)]),
    ...writeResponse(THREAD_RESULT_OFFSET, threadResult.length),
    0x0f,
    0x0b,
    ...methodMatches(METHOD_THREAD_RESUME_OFFSET, methodThreadResume),
    0x04,
    0x40,
    ...call(12, [...localGet(0), ...localGet(1)]),
    ...writeResponse(THREAD_RESULT_OFFSET, threadResult.length),
    0x0f,
    0x0b,
    ...methodMatches(METHOD_TURN_START_OFFSET, methodTurnStart),
    0x04,
    0x40,
    ...call(13, [...constant(LATEST_MCP_PATH), ...load(LATEST_MCP_PATH_LENGTH)]),
    ...writeResponse(TURN_RESULT_OFFSET, turnResult.length),
    ...call(9, [...constant(TURN_COMPLETED_OFFSET), ...constant(turnCompleted.length)]),
    0x0f,
    0x0b,
    ...methodMatches(METHOD_THREAD_READ_OFFSET, methodThreadRead),
    0x04,
    0x40,
    ...writeResponse(THREAD_RESULT_OFFSET, threadResult.length),
    0x0f,
    0x0b,
    0x0b,
  ];
  const startBody = [
    1,
    1,
    0x7f,
    ...call(9, [...constant(READY_OFFSET), ...constant(ready.length)]),
    0x02,
    0x40,
    0x03,
    0x40,
    ...call(8, [...constant(REQUEST_OFFSET)]),
    ...localSet(0),
    ...localGet(0),
    0x45,
    0x0d,
    1,
    ...call(15, [...constant(REQUEST_OFFSET), ...localGet(0)]),
    0x0c,
    0,
    0x0b,
    0x0b,
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
    10,
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([], []),
    ...functionType([0x7f, 0x7f], []),
    ...functionType([0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f], [0x7f]),
    ...functionType([0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f], [0x7f]),
    ...functionType([0x7f, 0x7f, 0x7f, 0x7f], []),
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
  const functions = [9, 6, 2, 7, 8, 2, 2, 9, 2, 1];
  const exports = [2, ...name("memory"), 2, 0, ...name("_start"), 0, 16];
  const codeBodies = [
    readLineBody,
    writeBody,
    findBody,
    parseIdBody,
    cacheMcpUrlBody,
    mcpBody,
    writeResponseBody,
    dispatchBody,
    startBody,
  ];
  const code = [codeBodies.length];
  for (const body of codeBodies) code.push(...leb(body.length), ...body);
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
