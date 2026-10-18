import { describe, expect, it, vi } from "vite-plus/test";
import {
  KernelWebSocketHost,
  type KernelWebSocketRouteRequest,
  type KernelWebSocketRouteResult,
  type KernelWebSocketRouteResponse,
  type KernelWebSocketWebSocket,
} from "../KernelWebSocketHost.ts";
import type { KernelDescriptorResource } from "../KernelDescriptors.ts";
import { KernelDescriptors } from "../KernelDescriptors.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelWakeRegistry } from "../KernelWakeRegistry.ts";

// Keep expected ABI values independent of the private encoder and resource implementation.
const WS_ERRNO = {
  EAGAIN: 6,
  EBADF: 8,
  EINVAL: 28,
  EIO: 29,
  EMSGSIZE: 35,
  ENOBUFS: 42,
  EPIPE: 64,
  ENOTSUP: 58,
  EFAULT: 21,
};
const MAX_HANDSHAKE_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_BLOCK_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 16 + 8 * 1024 + MAX_HEADER_BLOCK_BYTES;

describe("KernelWebSocketHost", () => {
  it("routes only validated loopback requests and preserves a non-upgrade response", async () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const descriptors = new FakeDescriptors();
    const routeRequest = deferred<KernelWebSocketRouteRequest>();
    const routeResponse = deferred<KernelWebSocketRouteResult>();
    const host = new KernelWebSocketHost({
      memory: () => memory,
      descriptors,
      route: (request) => {
        routeRequest.resolve(request);
        return routeResponse.promise;
      },
    });
    writeRequest(memory, 64, "ws://localhost:9777/exec", [
      ["upgrade", "websocket"],
      ["cookie", "a=1"],
      ["cookie", "b=2"],
    ]);

    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    expect(host.imports.ws_handshake(fd, 512, 1024, 32)).toBe(WS_ERRNO.EAGAIN);

    const input = await routeRequest.promise;
    expect(input.authority).toBe("localhost:9777");
    expect(input.headers).toEqual([
      ["upgrade", "websocket"],
      ["cookie", "a=1"],
      ["cookie", "b=2"],
    ]);
    expect(input.request.url).toBe("ws://localhost:9777/exec");

    routeResponse.resolve({
      response: new Response("not upgraded", {
        status: 200,
        headers: [["x-repeat", "coalesced by Response"]],
      }),
      headers: [
        ["content-type", "text/plain;charset=UTF-8"],
        ["set-cookie", "first=1; Path=/"],
        ["set-cookie", "second=2; Path=/"],
        ["x-repeat", "first"],
        ["x-repeat", "second"],
      ],
    });
    await waitForResourceRead(descriptors.resource(fd));

    expect(host.imports.ws_handshake(fd, 512, 2, 32)).toBe(WS_ERRNO.ENOBUFS);
    const required = readU32(memory, 32);
    expect(required).toBeGreaterThan(0);
    expect(host.imports.ws_handshake(fd, 512, required, 32)).toBe(0);
    expect(readU32(memory, 32)).toBe(required);
    expect(host.imports.ws_handshake(fd, 512, required, 32)).toBe(WS_ERRNO.EINVAL);
    expect(decodeHandshake(new Uint8Array(memory.buffer, 512, required))).toEqual({
      status: 200,
      headers: [
        ["content-type", "text/plain;charset=UTF-8"],
        ["set-cookie", "first=1; Path=/"],
        ["set-cookie", "second=2; Path=/"],
        ["x-repeat", "first"],
        ["x-repeat", "second"],
      ],
      body: "not upgraded",
    });
  });

  it("preserves an ordinary HTTP status, response body, and repeated raw headers", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const host = makeHost(memory, descriptors, () => ({
      status: 418,
      headers: [
        ["x-repeat", "first"],
        ["x-repeat", "second"],
      ],
      body: new TextEncoder().encode("teapot"),
    }));
    writeRequest(memory, 64, "ws://localhost/exec", []);

    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);

    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);
    const length = readU32(memory, 32);
    expect(decodeHandshake(new Uint8Array(memory.buffer, 512, length))).toEqual({
      status: 418,
      headers: [
        ["x-repeat", "first"],
        ["x-repeat", "second"],
      ],
      body: "teapot",
    });
    expect(host.imports.ws_drop(fd)).toBe(0);
  });

  it("rejects non-loopback targets before route or descriptor allocation", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    let routed = false;
    const host = new KernelWebSocketHost({
      memory: () => memory,
      descriptors,
      route: () => {
        routed = true;
        return { status: 500, headers: [] };
      },
    });
    writeRequest(memory, 64, "ws://example.com/exec", []);

    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(WS_ERRNO.ENOTSUP);
    expect(descriptors.size).toBe(0);
    expect(routed).toBe(false);
  });

  it("returns a numeric EFAULT for guest pointers outside current wasm memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const host = makeHost(memory, descriptors, () => ({ status: 200, headers: [] }));
    writeRequest(memory, 64, "ws://localhost/exec", []);

    expect(host.imports.ws_open(0xffff_fffc, 4, 16)).toBe(WS_ERRNO.EFAULT);
    expect(host.imports.ws_open(64, requestLength(memory), 0xffff_fffc)).toBe(WS_ERRNO.EFAULT);
    expect(host.imports.ws_handshake(3, 0, 1, 0xffff_fffc)).toBe(WS_ERRNO.EFAULT);
    expect(host.imports.ws_recv(3, 0xffff_fffc, 0, 0, 32)).toBe(WS_ERRNO.EFAULT);
    expect(host.imports.ws_send(3, 1, 0xffff_fffc, 4)).toBe(WS_ERRNO.EFAULT);
    expect(descriptors.size).toBe(0);
  });

  it("rejects oversized sends and invalid descriptors without copying guest data", async () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://localhost/exec", [], 4, 8);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

    const copy = vi.spyOn(Uint8Array.prototype, "slice");
    try {
      expect(host.imports.ws_send(fd, 2, 0, 65_536)).toBe(WS_ERRNO.EMSGSIZE);
      expect(host.imports.ws_send(99, 2, 0, 65_536)).toBe(WS_ERRNO.EBADF);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      host.imports.ws_drop(fd);
    }
  });

  it("rejects an untyped bare Response and closes its native socket", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const response = Object.assign(new Response("rejected"), { webSocket: socket });
    const host = makeHost(
      memory,
      descriptors,
      () => response as unknown as KernelWebSocketRouteResult,
    );
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));

    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(WS_ERRNO.EIO);
    expect(socket.closeCalls).toBe(1);
    host.imports.ws_drop(fd);
    expect(socket.closeCalls).toBe(1);
  });

  it("rejects an oversized guest request length before checking memory or routing", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    let routed = false;
    const host = makeHost(memory, descriptors, () => {
      routed = true;
      return { status: 200, headers: [] };
    });

    expect(host.imports.ws_open(0xffff_fffc, MAX_REQUEST_BYTES + 1, 16)).toBe(WS_ERRNO.EMSGSIZE);
    expect(descriptors.size).toBe(0);
    expect(routed).toBe(false);
  });

  it("counts the header-count field in the 64 KiB request and response header limits", async () => {
    const valueLength = MAX_HEADER_BLOCK_BYTES - 4 - 8 - 1;
    const value = "v".repeat(valueLength);
    const responseHandshake = async (headerValue: string) => {
      const memory = new WebAssembly.Memory({ initial: 2 });
      const descriptors = new FakeDescriptors();
      const host = makeHost(memory, descriptors, () => ({
        status: 200,
        headers: [["x", headerValue]],
        body: new Uint8Array(),
      }));
      writeRequest(memory, 64, "ws://localhost/exec", []);
      expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
      const fd = readU32(memory, 16);
      try {
        await waitForResourceRead(descriptors.resource(fd));
        return {
          errno: host.imports.ws_handshake(fd, 512, 8 + MAX_HEADER_BLOCK_BYTES, 32),
          length: readU32(memory, 32),
        };
      } finally {
        host.imports.ws_drop(fd);
      }
    };
    expect(await responseHandshake(value)).toEqual({
      errno: 0,
      length: 8 + MAX_HEADER_BLOCK_BYTES,
    });
    expect(await responseHandshake(`${value}v`)).toMatchObject({ errno: WS_ERRNO.EMSGSIZE });

    const memory = new WebAssembly.Memory({ initial: 2 });
    const descriptors = new FakeDescriptors();
    let routed = false;
    const host = makeHost(memory, descriptors, () => {
      routed = true;
      return { status: 200, headers: [] };
    });
    writeRequest(memory, 64, "ws://localhost/exec", [["x", value]]);
    expect(requestLength(memory)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));
    expect(routed).toBe(true);
    expect(host.imports.ws_drop(fd)).toBe(0);

    routed = false;
    writeRequest(memory, 64, "ws://localhost/exec", [["x", `${value}v`]]);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(WS_ERRNO.EMSGSIZE);
    expect(descriptors.size).toBe(0);
    expect(routed).toBe(false);
  });

  it("preserves duplicate response headers as raw Latin-1 bytes and rejects larger characters", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const host = makeHost(memory, descriptors, () => ({
      status: 200,
      headers: [
        ["x-byte", "é"],
        ["x-byte", "à"],
      ],
    }));
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);
    const encoded = new Uint8Array(memory.buffer, 512, readU32(memory, 32));
    expect([...encoded]).toContain(0xe9);
    expect(decodeHandshake(encoded).headers).toEqual([
      ["x-byte", "é"],
      ["x-byte", "à"],
    ]);
    expect(host.imports.ws_drop(fd)).toBe(0);

    const invalidMemory = new WebAssembly.Memory({ initial: 1 });
    const invalidDescriptors = new FakeDescriptors();
    const invalidHost = makeHost(invalidMemory, invalidDescriptors, () => ({
      status: 200,
      headers: [["x-byte", "Ā"]],
    }));
    writeRequest(invalidMemory, 64, "ws://localhost/exec", []);
    expect(invalidHost.imports.ws_open(64, requestLength(invalidMemory), 16)).toBe(0);
    const invalidFd = readU32(invalidMemory, 16);
    await waitForResourceRead(invalidDescriptors.resource(invalidFd));
    expect(invalidHost.imports.ws_handshake(invalidFd, 512, 128, 32)).toBe(WS_ERRNO.EIO);
    expect(invalidHost.imports.ws_drop(invalidFd)).toBe(0);
  });

  it("enforces frame, queue, URL and aggregate header bounds before routing", () => {
    const cases = [
      {
        url: "ws://localhost/exec",
        headers: [] as const,
        maxFrame: 1024 * 1024 + 1,
        maxQueue: 1024 * 1024 + 1,
        errno: WS_ERRNO.EINVAL,
      },
      {
        url: "ws://localhost/exec",
        headers: [] as const,
        maxFrame: 8,
        maxQueue: 7,
        errno: WS_ERRNO.EINVAL,
      },
      {
        url: `ws://localhost/${"x".repeat(8200)}`,
        headers: [] as const,
        maxFrame: 8,
        maxQueue: 8,
        errno: WS_ERRNO.EINVAL,
      },
      {
        url: "ws://localhost/exec",
        headers: [["x-test", "v".repeat(65_530)]] as const,
        maxFrame: 8,
        maxQueue: 8,
        errno: WS_ERRNO.EMSGSIZE,
      },
    ];
    for (const testCase of cases) {
      const memory = new WebAssembly.Memory({ initial: 2 });
      const descriptors = new FakeDescriptors();
      let routed = false;
      const host = new KernelWebSocketHost({
        memory: () => memory,
        descriptors,
        route: () => {
          routed = true;
          return { status: 500, headers: [] };
        },
      });
      writeRequest(
        memory,
        64,
        testCase.url,
        testCase.headers,
        testCase.maxFrame,
        testCase.maxQueue,
      );
      expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(testCase.errno);
      expect(descriptors.size).toBe(0);
      expect(routed).toBe(false);
    }
  });

  it("returns EMSGSIZE without encoding an oversized HTTP response as a success", async () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const descriptors = new FakeDescriptors();
    const host = makeHost(memory, descriptors, () => ({
      status: 200,
      headers: [],
      body: new Uint8Array(MAX_HANDSHAKE_BODY_BYTES + 1),
    }));
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);
    expect(host.imports.ws_handshake(fd, 512, 1024, 32)).toBe(WS_ERRNO.EMSGSIZE);
    expect(readU32(memory, 32)).toBe(0);
  });

  it("enforces the response header-block limit", async () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const descriptors = new FakeDescriptors();
    const host = makeHost(memory, descriptors, () => ({
      status: 200,
      headers: [["x-large", "v".repeat(65_536)]],
    }));
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));
    expect(host.imports.ws_handshake(fd, 512, 1024, 32)).toBe(WS_ERRNO.EMSGSIZE);
    expect(readU32(memory, 32)).toBe(0);
  });

  it("reports ENOBUFS without consuming a whole message, then returns it once", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://127.0.0.1/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(host.imports.ws_ready(fd)).toBe(0);

    socket.emit("message", { data: "hello" });
    expect(host.imports.ws_recv(fd, 24, 256, 2, 28)).toBe(WS_ERRNO.ENOBUFS);
    expect(readU32(memory, 24)).toBe(1);
    expect(readU32(memory, 28)).toBe(5);
    expect(host.imports.ws_recv(fd, 24, 256, 5, 28)).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 256, 5))).toBe("hello");
    expect(host.imports.ws_recv(fd, 24, 256, 5, 28)).toBe(WS_ERRNO.EAGAIN);
    expect(readU32(memory, 24)).toBe(1);
    expect(readU32(memory, 28)).toBe(5);

    socket.emit("message", { data: new Uint8Array([0, 255]).buffer });
    expect(host.imports.ws_recv(fd, 24, 256, 2, 28)).toBe(0);
    expect(readU32(memory, 24)).toBe(2);
    expect(new Uint8Array(memory.buffer, 256, 2)).toEqual(new Uint8Array([0, 255]));
  });

  it("closes on an oversized native message and reports the error before later EOF", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://localhost/exec", [], 4, 8);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

    socket.emit("message", { data: new Uint8Array(5).buffer });
    expect(resource.ready("read")).toMatchObject({ bytes: 0n, hangup: true });
    expect(resource.ready("write")).toMatchObject({ bytes: 0n, hangup: true });
    expect(host.imports.ws_recv(fd, 24, 256, 8, 28)).toBe(WS_ERRNO.EMSGSIZE);

    socket.emit("close", { code: 1009, reason: "" });
    expect(resource.ready("write")).toMatchObject({ bytes: 0n, hangup: true });
    expect(host.imports.ws_recv(fd, 24, 256, 8, 28)).toBe(0);
    expect(readU32(memory, 24)).toBe(8);
    expect(host.imports.ws_recv(fd, 24, 256, 8, 28)).toBe(WS_ERRNO.EMSGSIZE);
  });

  it("copies sends before returning, bounds the queue, and closes after handoff", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://localhost/exec", [], 4, 8);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

    memory.grow(1);
    new Uint8Array(memory.buffer, 256, 4).set([1, 2, 3, 4]);
    expect(host.imports.ws_send(fd, 2, 256, 4)).toBe(0);
    new Uint8Array(memory.buffer, 256, 4).fill(9);
    expect(host.imports.ws_flush(fd)).toBe(WS_ERRNO.EAGAIN);
    expect(resource.ready("write")).toBeUndefined();
    await Promise.resolve();
    expect(host.imports.ws_flush(fd)).toBe(0);
    expect(resource.ready("write")).toMatchObject({ bytes: 4n });
    expect(socket.sent).toEqual([[1, 2, 3, 4]]);
    expect(host.imports.ws_send(fd, 9, 256, 1)).toBe(WS_ERRNO.ENOTSUP);

    new Uint8Array(memory.buffer, 256, 4).set([0xef, 0xbb, 0xbf, 0x41]);
    expect(host.imports.ws_send(fd, 1, 256, 4)).toBe(0);
    expect(host.imports.ws_flush(fd)).toBe(WS_ERRNO.EAGAIN);
    await Promise.resolve();
    expect(host.imports.ws_flush(fd)).toBe(0);
    expect(socket.sent).toEqual([
      [1, 2, 3, 4],
      [0xef, 0xbb, 0xbf, 0x41],
    ]);

    expect(host.imports.ws_close(fd)).toBe(WS_ERRNO.EAGAIN);
    expect(resource.ready("write")).toBeUndefined();
    socket.emit("close", { code: 1000, reason: "ok" });
    expect(host.imports.ws_close(fd)).toBe(0);
    expect(resource.ready("write")).toMatchObject({ bytes: 0n, hangup: true });
    expect(host.imports.ws_recv(fd, 24, 512, 16, 28)).toBe(0);
    expect(readU32(memory, 24)).toBe(8);
    expect(new Uint8Array(memory.buffer, 512, 4)).toEqual(new Uint8Array([3, 232, 111, 107]));
  });

  it("closes after a native send failure and reports the typed error", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://localhost/exec", [], 4, 8);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const resource = descriptors.resource(fd);
    await waitForResourceRead(resource);
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

    socket.sendError = new Error("native send failed");
    new Uint8Array(memory.buffer, 256, 4).set([1, 2, 3, 4]);
    expect(host.imports.ws_send(fd, 2, 256, 4)).toBe(0);
    expect(host.imports.ws_send(fd, 2, 256, 4)).toBe(0);
    expect(host.imports.ws_flush(fd)).toBe(WS_ERRNO.EAGAIN);
    await Promise.resolve();

    expect(socket.sendCalls).toBe(1);
    expect(socket.closeCalls).toBe(1);
    expect(resource.ready("write")).toMatchObject({ bytes: 0n, hangup: true });
    expect(host.imports.ws_flush(fd)).toBe(WS_ERRNO.EIO);
    expect(host.imports.ws_recv(fd, 24, 256, 8, 28)).toBe(WS_ERRNO.EIO);
    expect(host.imports.ws_drop(fd)).toBe(0);
  });

  it("encodes a no-status native close as an empty close payload", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const host = makeHost(memory, descriptors, () => upgrade(socket));
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    await waitForResourceRead(descriptors.resource(fd));
    expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

    socket.emit("close", { code: 1005, reason: "" });

    expect(host.imports.ws_recv(fd, 24, 256, 0, 28)).toBe(0);
    expect(readU32(memory, 24)).toBe(8);
    expect(readU32(memory, 28)).toBe(0);
    expect(host.imports.ws_recv(fd, 24, 256, 0, 28)).toBe(0);
    expect(readU32(memory, 24)).toBe(0);
    expect(host.imports.ws_drop(fd)).toBe(0);
  });

  it("reports abnormal native close codes as EIO instead of fabricating a close frame", async () => {
    for (const code of [1006, 1015]) {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const descriptors = new FakeDescriptors();
      const socket = new FakeSocket();
      const host = makeHost(memory, descriptors, () => upgrade(socket));
      writeRequest(memory, 64, "ws://localhost/exec", []);
      expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
      const fd = readU32(memory, 16);
      const resource = descriptors.resource(fd);
      await waitForResourceRead(resource);
      expect(host.imports.ws_handshake(fd, 512, 128, 32)).toBe(0);

      socket.emit("close", { code, reason: "" });

      expect(resource.ready("read")).toMatchObject({ bytes: 0n, hangup: true });
      expect(host.imports.ws_recv(fd, 24, 256, 8, 28)).toBe(WS_ERRNO.EIO);
      expect(host.imports.ws_drop(fd)).toBe(0);
    }
  });

  it("wakes subscribe-after-check races and releases route/socket only at the last fd", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    let routed: KernelWebSocketRouteRequest | undefined;
    const host = makeHost(memory, descriptors, (request) => {
      routed = request;
      return upgrade(socket);
    });
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const first = descriptors.resource(fd);
    const alias = descriptors.duplicate(fd);
    const notified: string[] = [];
    const unsubscribe = first.subscribe("read", () => notified.push("read"));
    await waitForResourceRead(first);
    expect(notified).toContain("read");
    unsubscribe();
    expect(routed?.signal.aborted).toBe(false);

    expect(host.imports.ws_drop(fd)).toBe(0);
    expect(socket.closeCalls).toBe(0);
    expect(routed?.signal.aborted).toBe(false);
    expect(host.imports.ws_drop(alias)).toBe(0);
    expect(routed?.signal.aborted).toBe(true);
    expect(socket.closeCalls).toBe(1);
  });

  it("registers and releases WebSocket aliases through the real WASI descriptor table", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const filesystem = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(filesystem.descriptors, wakes);
    const table = filesystem.descriptors;
    const socket = new FakeSocket();
    const ownedFds: number[] = [];
    const host = new KernelWebSocketHost({
      memory: () => memory,
      descriptors,
      route: () => upgrade(socket),
    });
    writeRequest(memory, 64, "ws://localhost/exec", []);

    try {
      expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
      const fd = readU32(memory, 16);
      ownedFds.push(fd);
      const alias = descriptors.duplicate(fd);
      ownedFds.push(alias);
      const resource = descriptors.resource(fd);
      expect(fd).toBe(3);
      expect(table.get(fd).kind).toBe("stdio");
      await waitForResourceRead(resource);

      expect(host.imports.ws_drop(fd)).toBe(0);
      expect(descriptors.resource(alias)).toBe(resource);
      expect(socket.closeCalls).toBe(0);
      expect(host.imports.ws_drop(alias)).toBe(0);
      await socket.closeCompleted.promise;
      expect(socket.closeCalls).toBe(1);
      expect(table.has(fd)).toBe(false);
      expect(table.has(alias)).toBe(false);
      expect(wakes.size).toBe(0);
    } finally {
      for (const fd of ownedFds) {
        if (table.has(fd)) descriptors.close(fd);
      }
      filesystem.dispose();
      wakes.dispose();
    }
  });

  it("aborts a pending route on the final drop and closes a late upgrade", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new FakeDescriptors();
    const socket = new FakeSocket();
    const routeStarted = deferred<KernelWebSocketRouteRequest>();
    const routeResponse = deferred<KernelWebSocketRouteResponse>();
    const host = new KernelWebSocketHost({
      memory: () => memory,
      descriptors,
      route: (request) => {
        routeStarted.resolve(request);
        return routeResponse.promise;
      },
    });
    writeRequest(memory, 64, "ws://localhost/exec", []);
    expect(host.imports.ws_open(64, requestLength(memory), 16)).toBe(0);
    const fd = readU32(memory, 16);
    const request = await routeStarted.promise;

    expect(host.imports.ws_drop(fd)).toBe(0);
    expect(request.signal.aborted).toBe(true);
    routeResponse.resolve(upgrade(socket));
    await socket.closeCompleted.promise;
    expect(socket.closeCalls).toBe(1);
  });
});

function makeHost(
  memory: WebAssembly.Memory,
  descriptors: FakeDescriptors,
  route: (
    request: KernelWebSocketRouteRequest,
  ) => KernelWebSocketRouteResult | Promise<KernelWebSocketRouteResult>,
): KernelWebSocketHost {
  return new KernelWebSocketHost({
    memory: () => memory,
    descriptors,
    route: (request) => route(request),
  });
}

function upgrade(socket: FakeSocket): KernelWebSocketRouteResponse {
  return { status: 101, headers: [], webSocket: socket as unknown as KernelWebSocketWebSocket };
}

function writeRequest(
  memory: WebAssembly.Memory,
  pointer: number,
  url: string,
  headers: readonly (readonly [string, string])[],
  maxFrameBytes = 32,
  maxQueueBytes = 64,
): void {
  const encoder = new TextEncoder();
  const encodedUrl = encoder.encode(url);
  const encodedHeaders = headers.map(
    ([name, value]) => [encoder.encode(name), encoder.encode(value)] as const,
  );
  const size =
    20 +
    encodedUrl.byteLength +
    encodedHeaders.reduce(
      (total, [name, value]) => total + 8 + name.byteLength + value.byteLength,
      0,
    );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const value of [1, maxFrameBytes, maxQueueBytes, encodedUrl.byteLength]) {
    view.setUint32(offset, value, true);
    offset += 4;
  }
  bytes.set(encodedUrl, offset);
  offset += encodedUrl.byteLength;
  view.setUint32(offset, encodedHeaders.length, true);
  offset += 4;
  for (const [name, value] of encodedHeaders) {
    view.setUint32(offset, name.byteLength, true);
    offset += 4;
    bytes.set(name, offset);
    offset += name.byteLength;
    view.setUint32(offset, value.byteLength, true);
    offset += 4;
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  new Uint8Array(memory.buffer, pointer, size).set(bytes);
  writeU32(memory, 8, size);
}

function requestLength(memory: WebAssembly.Memory): number {
  return readU32(memory, 8);
}

function readU32(memory: WebAssembly.Memory, pointer: number): number {
  return new DataView(memory.buffer).getUint32(pointer, true);
}

function writeU32(memory: WebAssembly.Memory, pointer: number, value: number): void {
  new DataView(memory.buffer).setUint32(pointer, value, true);
}

function decodeHandshake(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const status = view.getUint32(offset, true);
  offset += 4;
  const headerCount = view.getUint32(offset, true);
  offset += 4;
  const headers: Array<[string, string]> = [];
  for (let index = 0; index < headerCount; index++) {
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const name = decodeLatin1(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const valueLength = view.getUint32(offset, true);
    offset += 4;
    const value = decodeLatin1(bytes.subarray(offset, offset + valueLength));
    offset += valueLength;
    headers.push([name, value]);
  }
  const bodyLength = view.getUint32(offset, true);
  offset += 4;
  return { status, headers, body: decoder.decode(bytes.subarray(offset, offset + bodyLength)) };
}

function decodeLatin1(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

async function waitForResourceRead(resource: KernelDescriptorResource): Promise<void> {
  if (resource.ready("read") !== undefined) return;
  await new Promise<void>((resolve) => {
    let unsubscribe = () => {};
    const notify = () => {
      unsubscribe();
      resolve();
    };
    unsubscribe = resource.subscribe("read", notify);
    if (resource.ready("read") !== undefined) notify();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class FakeDescriptors {
  readonly #entries = new Map<
    number,
    { readonly resource: KernelDescriptorResource; references: number }
  >();
  #nextFd = 3;

  get size() {
    return this.#entries.size;
  }

  register(resource: KernelDescriptorResource): number {
    const fd = this.#nextFd++;
    this.#entries.set(fd, { resource, references: 1 });
    return fd;
  }

  resource(fd: number): KernelDescriptorResource {
    const entry = this.#entries.get(fd);
    if (entry === undefined) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    return entry.resource;
  }

  duplicate(fd: number): number {
    const entry = this.#entries.get(fd);
    if (entry === undefined) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    const duplicate = this.#nextFd++;
    entry.references++;
    this.#entries.set(duplicate, entry);
    return duplicate;
  }

  close(fd: number): void {
    const entry = this.#entries.get(fd);
    if (entry === undefined) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    this.#entries.delete(fd);
    entry.references--;
    if (entry.references === 0) entry.resource.close();
  }
}

class FakeSocket {
  readyState = 1;
  binaryType = "blob";
  readonly sent: number[][] = [];
  sendError: Error | undefined;
  sendCalls = 0;
  closeCalls = 0;
  readonly closeCompleted = deferred<void>();
  readonly #listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (this.binaryType !== "arraybuffer")
      throw new Error("binaryType must be set before listeners");
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sendCalls++;
    if (this.sendError !== undefined) throw this.sendError;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push([...bytes]);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 2;
    this.closeCompleted.resolve();
  }

  emit(type: string, event: object = {}): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- Listeners may mutate the set during delivery.
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event as Event);
    }
  }
}
