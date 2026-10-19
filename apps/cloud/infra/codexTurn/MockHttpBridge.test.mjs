import * as NodeAssert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { createMockHttpAdapter } from "./MockHttpAdapter.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FD_OUT = 16;
const SENT_OUT = 20;
const LENGTH_OUT = 24;
const FAULT = 21;
const REQUEST = 1024;
const RESPONSE = 64 * 1024;
const RECEIVE_TIMEOUT = 256;

class SharedDescriptors {
  entries = new Map();

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

function createHarness(handleRequest) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const descriptors = new SharedDescriptors();
  const adapter = createMockHttpAdapter({ memory: () => memory, descriptors, handleRequest });
  const address = encoder.encode("mock.invalid:80");
  new Uint8Array(memory.buffer, REQUEST, address.byteLength).set(address);
  NodeAssert.equal(adapter.imports.net_socket(1, 6, 0, FD_OUT), 0);
  const fd = new DataView(memory.buffer).getUint32(FD_OUT, true);
  NodeAssert.equal(adapter.imports.net_connect(fd, REQUEST, address.byteLength), 0);
  return { memory, descriptors, adapter, fd };
}

function send(harness, bytes) {
  const { adapter, memory, fd } = harness;
  new Uint8Array(memory.buffer, REQUEST, bytes.byteLength).set(bytes);
  NodeAssert.equal(adapter.imports.net_send(fd, REQUEST, bytes.byteLength, 0, SENT_OUT), 0);
  NodeAssert.equal(new DataView(memory.buffer).getUint32(SENT_OUT, true), bytes.byteLength);
}

async function receiveAll(harness) {
  const { adapter, memory, fd } = harness;
  const chunks = [];
  for (;;) {
    NodeAssert.equal(await adapter.imports.net_recv(fd, RESPONSE, 257, 0, LENGTH_OUT), 0);
    const length = new DataView(memory.buffer).getUint32(LENGTH_OUT, true);
    if (length === 0) break;
    chunks.push(new Uint8Array(memory.buffer, RESPONSE, length).slice());
  }
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(output);
}

function setReceiveTimeout(harness) {
  const timeval = new Uint8Array(16);
  new DataView(timeval.buffer).setBigInt64(8, 2000n, true);
  new Uint8Array(harness.memory.buffer, RECEIVE_TIMEOUT, timeval.byteLength).set(timeval);
  NodeAssert.equal(
    harness.adapter.imports.net_setsockopt(harness.fd, 1, 20, RECEIVE_TIMEOUT, timeval.byteLength),
    0,
  );
}

function trackSubscriptions(socket) {
  let active = 0;
  const subscribe = socket.subscribe.bind(socket);
  socket.subscribe = (direction, notify) => {
    const unsubscribe = subscribe(direction, notify);
    active++;
    return () => {
      active--;
      unsubscribe();
    };
  };
  return () => active;
}

function makeRequest() {
  const body = encoder.encode(
    JSON.stringify({
      model: "gpt-codex",
      input: [{ role: "user", content: "{{secret:API_TOKEN}}" }],
      stream: true,
    }),
  );
  const head = encoder.encode(
    "POST /v1/responses?stream=true HTTP/1.1\r\n" +
      "Host: mock.invalid\r\n" +
      "Authorization: Bearer mock-only\r\n" +
      "OpenAI-Beta: responses=experimental\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${body.byteLength}\r\n\r\n`,
  );
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);
  return { bytes, body: decoder.decode(body) };
}

test("bridges split native HTTP requests through an async handler and frames streamed responses", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let forwarded;
  const harness = createHarness(async (request) => {
    forwarded = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      beta: request.headers.get("openai-beta"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    };
    entered.resolve();
    await release.promise;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.created\n"));
        controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 207,
      statusText: "Multi-Status",
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-proof-route": "native",
      },
    });
  });
  const socket = harness.descriptors.resource(harness.fd);
  const { bytes, body } = makeRequest();

  for (let offset = 0; offset < bytes.byteLength; offset += 11) {
    const end = Math.min(offset + 11, bytes.byteLength);
    send(harness, bytes.subarray(offset, end));
    if (end < bytes.byteLength) NodeAssert.equal(socket.ready("read"), undefined);
  }

  await entered.promise;
  NodeAssert.deepEqual(forwarded, {
    url: "http://mock.invalid/v1/responses?stream=true",
    method: "POST",
    authorization: "Bearer mock-only",
    beta: "responses=experimental",
    contentType: "application/json",
    body,
  });
  NodeAssert.equal(
    socket.ready("read"),
    undefined,
    "the response stays pending until its handler resolves",
  );

  let unsubscribe = () => undefined;
  const responseReady = new Promise((resolve) => {
    unsubscribe = socket.subscribe("read", () => {
      unsubscribe();
      resolve();
    });
  });
  release.resolve();
  await responseReady;

  const response = await receiveAll(harness);
  const responseBody = 'event: response.created\ndata: {"type":"response.created"}\n\n';
  NodeAssert.match(response, /^HTTP\/1\.1 207 Multi-Status\r\n/);
  NodeAssert.match(response, /\r\ncontent-type: text\/event-stream\r\n/);
  NodeAssert.match(response, /\r\ncache-control: no-cache\r\n/);
  NodeAssert.match(response, /\r\nx-proof-route: native\r\n/);
  NodeAssert.match(
    response,
    new RegExp(`\\r\\nContent-Length: ${encoder.encode(responseBody).byteLength}\\r\\n`),
  );
  NodeAssert.match(response, /\r\nConnection: close\r\n\r\n/);
  NodeAssert.equal(response.slice(response.indexOf("\r\n\r\n") + 4), responseBody);
  NodeAssert.equal(harness.adapter.imports.net_close(harness.fd), 0);
});

test("turns async handler failures into a bounded HTTP error without echoing error text", async () => {
  const harness = createHarness(async () => {
    throw new Error("must not leak fixture-secret-value");
  });
  const socket = harness.descriptors.resource(harness.fd);
  const responseReady = new Promise((resolve) => {
    let unsubscribe = () => undefined;
    unsubscribe = socket.subscribe("read", () => {
      unsubscribe();
      resolve();
    });
  });
  send(harness, makeRequest().bytes);
  await responseReady;

  const response = await receiveAll(harness);
  NodeAssert.match(response, /^HTTP\/1\.1 502 HTTP Handler Failed\r\n/);
  NodeAssert.match(response, /\r\n\r\nHTTP Handler Failed\n$/);
  NodeAssert.equal(response.includes("fixture-secret-value"), false);
  NodeAssert.equal(harness.adapter.imports.net_close(harness.fd), 0);
});

test("keeps a native receive pending until the async model HTTP response is ready", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  vi.useFakeTimers();
  const harness = createHarness(async () => {
    entered.resolve();
    await release.promise;
    return new Response("actual model HTTP bytes", { status: 200 });
  });
  setReceiveTimeout(harness);
  const socket = harness.descriptors.resource(harness.fd);
  const activeSubscriptions = trackSubscriptions(socket);
  try {
    send(harness, makeRequest().bytes);
    const pendingRead = harness.adapter.imports.net_recv(harness.fd, RESPONSE, 512, 0, LENGTH_OUT);
    await entered.promise;
    NodeAssert.equal(activeSubscriptions(), 1);
    NodeAssert.equal(vi.getTimerCount(), 1);
    harness.memory.grow(1);
    release.resolve();
    const errno = await pendingRead;
    NodeAssert.equal(errno, 0);
    const length = new DataView(harness.memory.buffer).getUint32(LENGTH_OUT, true);
    const response = decoder.decode(new Uint8Array(harness.memory.buffer, RESPONSE, length));
    NodeAssert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    NodeAssert.match(response, /\r\n\r\nactual model HTTP bytes$/);
    NodeAssert.equal(activeSubscriptions(), 0);
    NodeAssert.equal(vi.getTimerCount(), 0);
  } finally {
    release.resolve();
    harness.adapter.imports.net_close(harness.fd);
    vi.useRealTimers();
  }
});

test("returns EAGAIN after the supported two millisecond receive timeout", async () => {
  vi.useFakeTimers();
  const harness = createHarness(async () => new Response("unused"));
  setReceiveTimeout(harness);
  const socket = harness.descriptors.resource(harness.fd);
  const activeSubscriptions = trackSubscriptions(socket);
  try {
    const pendingRead = harness.adapter.imports.net_recv(harness.fd, RESPONSE, 512, 0, LENGTH_OUT);
    NodeAssert.equal(activeSubscriptions(), 1);
    NodeAssert.equal(vi.getTimerCount(), 1);

    await vi.advanceTimersByTimeAsync(2);

    NodeAssert.equal(await pendingRead, 6);
    NodeAssert.equal(new DataView(harness.memory.buffer).getUint32(LENGTH_OUT, true), 0);
    NodeAssert.equal(activeSubscriptions(), 0);
    NodeAssert.equal(vi.getTimerCount(), 0);
  } finally {
    harness.adapter.imports.net_close(harness.fd);
    vi.useRealTimers();
  }
});

test("rejects an invalid receive range before subscribing or starting the timeout", async () => {
  vi.useFakeTimers();
  const harness = createHarness(async () => new Response("unused"));
  setReceiveTimeout(harness);
  const socket = harness.descriptors.resource(harness.fd);
  const activeSubscriptions = trackSubscriptions(socket);
  try {
    const pendingRead = harness.adapter.imports.net_recv(harness.fd, 130_000, 2_000, 0, LENGTH_OUT);
    await vi.advanceTimersByTimeAsync(2);

    NodeAssert.equal(await pendingRead, FAULT);
    NodeAssert.equal(activeSubscriptions(), 0);
    NodeAssert.equal(vi.getTimerCount(), 0);
  } finally {
    harness.adapter.imports.net_close(harness.fd);
    vi.useRealTimers();
  }
});

test("closing a socket wakes its pending receive with BADF and clears its timeout", async () => {
  vi.useFakeTimers();
  const harness = createHarness(async () => new Response("unused"));
  setReceiveTimeout(harness);
  const socket = harness.descriptors.resource(harness.fd);
  const activeSubscriptions = trackSubscriptions(socket);
  try {
    const pendingRead = harness.adapter.imports.net_recv(harness.fd, RESPONSE, 512, 0, LENGTH_OUT);
    NodeAssert.equal(activeSubscriptions(), 1);
    NodeAssert.equal(vi.getTimerCount(), 1);

    NodeAssert.equal(harness.adapter.imports.net_close(harness.fd), 0);

    NodeAssert.equal(await pendingRead, 8);
    NodeAssert.equal(activeSubscriptions(), 0);
    NodeAssert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});
