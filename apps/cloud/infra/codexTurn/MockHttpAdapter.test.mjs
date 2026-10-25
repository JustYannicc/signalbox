import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createMockResponses } from "./MockResponses.mjs";
import { createMockHttpAdapter } from "./MockHttpAdapter.mjs";

const AFNOSUPPORT = 5;
const HOSTUNREACH = 23;
const NOTSUP = 58;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FD_OUT = 16;
const SENT_OUT = 20;
const LENGTH_OUT = 24;
const ADDRESS = 256;
const REQUEST = 1024;
const RESPONSE = 16 * 1024;

class SharedDescriptors {
  constructor() {
    this.entries = new Map([
      [0, { kind: "stdin" }],
      [1, { kind: "stdout" }],
      [2, { kind: "stderr" }],
      [
        3,
        {
          kind: "existing",
          closed: false,
          close() {
            this.closed = true;
          },
        },
      ],
    ]);
  }

  register(resource) {
    let fd = 0;
    while (this.entries.has(fd)) fd++;
    this.entries.set(fd, resource);
    return fd;
  }

  resource(fd) {
    const resource = this.entries.get(fd);
    if (!resource) throw Object.assign(new Error("Bad descriptor"), { code: "EBADF" });
    return resource;
  }

  close(fd) {
    const resource = this.resource(fd);
    this.entries.delete(fd);
    resource.close?.();
  }
}

function createHarness(mock = createMockResponses()) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const descriptors = new SharedDescriptors();
  const adapter = createMockHttpAdapter({ memory: () => memory, descriptors, mock });
  return { memory, descriptors, adapter, mock };
}

function writeBytes(memory, pointer, bytes) {
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
}

function writeText(memory, pointer, value) {
  const bytes = encoder.encode(value);
  writeBytes(memory, pointer, bytes);
  return bytes.byteLength;
}

function readU32(memory, pointer) {
  return new DataView(memory.buffer).getUint32(pointer, true);
}

function openSocket(harness) {
  const { memory, adapter } = harness;
  NodeAssert.equal(adapter.imports.net_socket(1, 6, 0, FD_OUT), 0);
  return readU32(memory, FD_OUT);
}

function connectMock(harness, fd) {
  const { memory, adapter } = harness;
  const length = writeText(memory, ADDRESS, "mock.invalid:80");
  NodeAssert.equal(adapter.imports.net_connect(fd, ADDRESS, length), 0);
}

function makeRequest(path = "/v1/responses", body = '{"input":[]}') {
  const bodyBytes = encoder.encode(body);
  const head = encoder.encode(
    "POST " +
      path +
      " HTTP/1.1\r\n" +
      "Host: mock.invalid\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: " +
      bodyBytes.byteLength +
      "\r\n\r\n",
  );
  const bytes = new Uint8Array(head.byteLength + bodyBytes.byteLength);
  bytes.set(head);
  bytes.set(bodyBytes, head.byteLength);
  return bytes;
}

function sendBytes(harness, fd, bytes) {
  const { memory, adapter } = harness;
  writeBytes(memory, REQUEST, bytes);
  NodeAssert.equal(adapter.imports.net_send(fd, REQUEST, bytes.byteLength, 0, SENT_OUT), 0);
  NodeAssert.equal(readU32(memory, SENT_OUT), bytes.byteLength);
}

function receiveAll(harness, fd, capacity) {
  const { memory, adapter } = harness;
  const chunks = [];
  for (;;) {
    const errno = adapter.imports.net_recv(fd, RESPONSE, capacity, 0, LENGTH_OUT);
    NodeAssert.equal(errno, 0);
    const length = readU32(memory, LENGTH_OUT);
    if (length === 0) break;
    chunks.push(new Uint8Array(memory.buffer, RESPONSE, length).slice());
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function expectedSseResponse(sse) {
  const length = encoder.encode(sse).byteLength;
  return (
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Cache-Control: no-cache\r\n" +
    "Connection: close\r\n" +
    "Content-Length: " +
    length +
    "\r\n\r\n" +
    sse
  );
}

test("matches the R3 host_net imports and AgentOS socket constants", () => {
  const harness = createHarness();
  const imports = harness.adapter.getImportObject().host_net;
  NodeAssert.deepEqual(
    Object.fromEntries(Object.entries(imports).map(([name, fn]) => [name, fn.length])),
    {
      net_socket: 4,
      net_connect: 3,
      net_send: 5,
      net_recv: 5,
      net_close: 1,
      net_getaddrinfo: 7,
      net_tls_connect: 3,
      net_setsockopt: 5,
      net_getsockname: 3,
      net_getpeername: 3,
      net_poll: 4,
      net_bind: 3,
      net_listen: 2,
      net_accept: 4,
      net_sendto: 7,
      net_recvfrom: 7,
      net_validate_socket: 1,
    },
  );

  NodeAssert.equal(harness.adapter.imports.net_socket(2, 1, 0, FD_OUT), AFNOSUPPORT);
  const fd = openSocket(harness);
  NodeAssert.equal(fd, 4, "the shared descriptor table owns fd allocation");
  NodeAssert.equal(harness.adapter.imports.net_validate_socket(fd), 0);
  NodeAssert.equal(harness.adapter.imports.net_validate_socket(3), 57);
  NodeAssert.equal(harness.adapter.imports.net_validate_socket(99), 8);

  const tlsHostLength = writeText(harness.memory, ADDRESS, "mock.invalid");
  NodeAssert.equal(harness.adapter.imports.net_tls_connect(fd, ADDRESS, tlsHostLength), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_getsockname(fd, 0, 4), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_getpeername(fd, 0, 4), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_poll(0, 0, 0, 4), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_bind(fd, 0, 0), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_listen(fd, 0), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_accept(fd, 0, 0, 0), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_sendto(fd, 0, 0, 0, 0, 0, 0), NOTSUP);
  NodeAssert.equal(harness.adapter.imports.net_recvfrom(fd, 0, 0, 0, 0, 0, 0), NOTSUP);
});

test("requires JSPI only when wrapping async native HTTP receives", async () => {
  const suspendingDescriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Suspending");
  try {
    Object.defineProperty(WebAssembly, "Suspending", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const syncHarness = createHarness();
    NodeAssert.equal(typeof syncHarness.adapter.getImportObject().host_net.net_recv, "function");

    const memory = new WebAssembly.Memory({ initial: 1 });
    const asyncAdapter = createMockHttpAdapter({
      memory: () => memory,
      descriptors: new SharedDescriptors(),
      handleRequest: async () => new Response("async"),
    });
    NodeAssert.throws(() => asyncAdapter.getImportObject(), {
      code: "ERR_CODEX_JSPI_UNAVAILABLE",
      message: "Codex async HTTP receive requires WebAssembly JSPI",
    });

    class TestSuspending {
      constructor(fn) {
        this.fn = fn;
      }

      invoke(...args) {
        return this.fn(...args);
      }
    }
    Object.defineProperty(WebAssembly, "Suspending", {
      configurable: true,
      writable: true,
      value: TestSuspending,
    });
    const wrapped = asyncAdapter.getImportObject().host_net.net_recv;
    NodeAssert.ok(wrapped instanceof TestSuspending);
    NodeAssert.equal(await wrapped.invoke(99, 8, 0, 0, 0), 8);
  } finally {
    if (suspendingDescriptor === undefined) delete WebAssembly.Suspending;
    else Object.defineProperty(WebAssembly, "Suspending", suspendingDescriptor);
  }
});

test("buffers fragmented HTTP by Content-Length and returns exact HTTP/SSE bytes", () => {
  const harness = createHarness();
  const fd = openSocket(harness);
  connectMock(harness, fd);

  const timeval = new Uint8Array(16);
  new DataView(timeval.buffer).setBigInt64(8, 2000n, true);
  writeBytes(harness.memory, ADDRESS, timeval);
  NodeAssert.equal(
    harness.adapter.imports.net_setsockopt(fd, 1, 20, ADDRESS, timeval.byteLength),
    0,
  );
  const socket = harness.descriptors.resource(fd);
  NodeAssert.equal(socket.recvTimeoutMs, 2);

  let readWakeups = 0;
  const unsubscribe = socket.subscribe("read", () => readWakeups++);
  const request = makeRequest();
  for (let start = 0; start < request.byteLength; start += 7) {
    const end = Math.min(start + 7, request.byteLength);
    sendBytes(harness, fd, request.subarray(start, end));
    if (end < request.byteLength) {
      NodeAssert.equal(harness.mock.requests.length, 0);
      NodeAssert.equal(socket.ready("read"), undefined);
    }
  }

  NodeAssert.equal(harness.mock.requests.length, 1);
  NodeAssert.equal(socket.ready("read").bytes > 0n, true);
  NodeAssert.equal(readWakeups, 1);

  const actual = receiveAll(harness, fd, 19);
  const sse =
    "event: response.created\n" +
    'data: {"type":"response.created","response":{"id":"resp-1069-startup"}}\n\n' +
    "event: response.completed\n" +
    'data: {"type":"response.completed","response":{"id":"resp-1069-startup","usage":{"input_tokens":0,"input_tokens_details":null,"output_tokens":0,"output_tokens_details":null,"total_tokens":0}}}\n\n';
  NodeAssert.equal(decoder.decode(actual), expectedSseResponse(sse));

  unsubscribe();
  NodeAssert.equal(harness.adapter.imports.net_close(fd), 0);
  NodeAssert.equal(socket.closed, true);
  NodeAssert.deepEqual([...harness.descriptors.entries.keys()], [0, 1, 2, 3]);
  NodeAssert.equal(harness.descriptors.entries.get(3).closed, false);
  NodeAssert.equal(readWakeups, 1, "unsubscribed readiness listeners are cleaned up");
});

test("rejects a request outside /v1/responses without calling the mock", () => {
  let mockCalls = 0;
  const harness = createHarness({
    respond() {
      mockCalls++;
      return "event: unexpected\n\n";
    },
  });
  const fd = openSocket(harness);
  connectMock(harness, fd);
  sendBytes(harness, fd, makeRequest("/v1/other"));

  const response = decoder.decode(receiveAll(harness, fd, 32));
  NodeAssert.match(response, /^HTTP\/1\.1 404 Not Found\r\n/);
  NodeAssert.match(response, /\r\n\r\nNot Found\n$/);
  NodeAssert.equal(mockCalls, 0);
});

test("rejects non-mock hosts and resolves only mock.invalid:80", () => {
  const harness = createHarness();
  const fd = openSocket(harness);
  const addressLength = writeText(harness.memory, ADDRESS, "other.invalid:80");
  NodeAssert.equal(harness.adapter.imports.net_connect(fd, ADDRESS, addressLength), HOSTUNREACH);

  const hostLength = writeText(harness.memory, ADDRESS, "mock.invalid");
  const portLength = writeText(harness.memory, ADDRESS + 32, "80");
  new DataView(harness.memory.buffer).setUint32(LENGTH_OUT, 32, true);
  NodeAssert.equal(
    harness.adapter.imports.net_getaddrinfo(
      ADDRESS,
      hostLength,
      ADDRESS + 32,
      portLength,
      0,
      RESPONSE,
      LENGTH_OUT,
    ),
    0,
  );
  NodeAssert.equal(
    decoder.decode(
      new Uint8Array(harness.memory.buffer, RESPONSE, readU32(harness.memory, LENGTH_OUT)),
    ),
    "mock.invalid:80",
  );

  const otherLength = writeText(harness.memory, ADDRESS, "other.invalid");
  NodeAssert.equal(
    harness.adapter.imports.net_getaddrinfo(
      ADDRESS,
      otherLength,
      ADDRESS + 32,
      portLength,
      0,
      RESPONSE,
      LENGTH_OUT,
    ),
    HOSTUNREACH,
  );
});
