import { describe, expect, it } from "vite-plus/test";
import { KernelHttpNetworkHost } from "../../KernelHttpNetworkHost.ts";
import { ADDRESS, DATA, OUTPUT, fixture, readable, decoder } from "./fixture.ts";

const request = "GET /stream?x=1 HTTP/1.1\r\nHost: api.example\r\n\r\n";

describe("KernelHttpNetworkHost lifecycle", () => {
  it("forces HTTPS after TLS hostname validation and preserves the configured destination port", async () => {
    const called = Promise.withResolvers<Request>();
    const f = fixture(async (input) => {
      called.resolve(input);
      return new Response("secure");
    });
    try {
      const fd = f.open("api.example:8443");
      expect(f.imports.net_tls_connect(fd, ADDRESS, f.write(ADDRESS, "api.example"))).toBe(0);
      expect(f.send(fd, "GET /secure?q=1 HTTP/1.1\r\nHost: api.example:8443\r\n\r\n")).toBe(0);
      const input = await called.promise;
      expect(input.url).toBe("https://api.example:8443/secure?q=1");
      expect(input.redirect).toBe("manual");
      await f.receive(fd);
    } finally {
      await f.close();
    }
  });

  it("rejects a TLS hostname mismatch and an insecure absolute target without invoking fetch", async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return new Response();
    });
    try {
      const wrong = f.open("api.example:443");
      expect(f.imports.net_tls_connect(wrong, ADDRESS, f.write(ADDRESS, "other.example"))).toBe(28);
      expect(f.send(wrong, request)).toBe(28);
      const secure = f.open("api.example:443");
      expect(f.imports.net_tls_connect(secure, ADDRESS, f.write(ADDRESS, "api.example"))).toBe(0);
      expect(f.send(secure, "GET http://api.example/ HTTP/1.1\r\nHost: api.example\r\n\r\n")).toBe(
        28,
      );
      expect(calls).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("surfaces verified TLS transport rejection as receive failure with hangup readiness", async () => {
    const f = fixture(async (input) => {
      expect(input.url).toBe("https://api.example/");
      throw new Error("certificate rejected");
    });
    try {
      const fd = f.open("api.example:443");
      expect(f.imports.net_tls_connect(fd, ADDRESS, f.write(ADDRESS, "api.example"))).toBe(0);
      expect(f.send(fd, "GET / HTTP/1.1\r\nHost: api.example\r\n\r\n")).toBe(0);
      await readable(f.descriptors.resource(fd));
      expect(f.imports.net_recv(fd, OUTPUT, 32, 0, 24)).toBe(29);
      expect(f.descriptors.resource(fd).ready("read")).toEqual({ bytes: 0n, hangup: true });
    } finally {
      await f.close();
    }
  });

  it("retains general receive timevals while reads remain nonblocking", async () => {
    const f = fixture();
    try {
      const fd = f.open();
      const view = new DataView(f.memory.buffer, DATA, 16);
      view.setBigInt64(0, 1n, true);
      view.setBigInt64(8, 234567n, true);
      expect(f.imports.net_setsockopt(fd, 1, 20, DATA, 16)).toBe(0);
      expect(f.descriptors.resource(fd)).toMatchObject({ recvTimeoutMs: 1234.567 });
      expect(f.imports.net_recv(fd, OUTPUT, 32, 0, 24)).toBe(6);
      expect(f.u32(24)).toBe(0);
      view.setBigInt64(8, 1_000_000n, true);
      expect(f.imports.net_setsockopt(fd, 1, 20, DATA, 16)).toBe(28);
      view.setBigInt64(0, 0n, true);
      view.setBigInt64(8, 0n, true);
      expect(f.imports.net_setsockopt(fd, 1, 20, DATA, 16)).toBe(0);
      expect(f.descriptors.resource(fd)).toMatchObject({ recvTimeoutMs: null });
      expect(f.imports.net_setsockopt(fd, 1, 21, DATA, 16)).toBe(58);
    } finally {
      await f.close();
    }
  });

  it("cancels fetch and wakes real kernel descriptor subscribers on parent abort", async () => {
    const called = Promise.withResolvers<Request>();
    const reply = Promise.withResolvers<Response>();
    const f = fixture(async (input) => {
      called.resolve(input);
      return reply.promise;
    });
    try {
      const fd = f.open();
      const token = f.wakes.register((notify) =>
        f.descriptors.resource(fd).subscribe("read", notify),
      );
      if (token.status !== "ok") throw new Error("Wake registration failed");
      const waiting = f.wakes.wait(token.value, new AbortController().signal);
      expect(f.send(fd, request)).toBe(0);
      const input = await called.promise;
      f.abort.abort();
      expect(input.signal.aborted).toBe(true);
      expect((await waiting).status).toBe("ok");
      f.wakes.release(token.value);
      expect(f.imports.net_recv(fd, OUTPUT, 32, 0, 24)).toBe(11);
      reply.resolve(new Response());
      await f.host.dispose();
      expect(f.wakes.size).toBe(0);
    } finally {
      reply.resolve(new Response());
      await f.close();
    }
  });

  it("keeps a dup alias alive and does not close an unrelated resource that reused the original fd", async () => {
    const called = Promise.withResolvers<Request>();
    const reply = Promise.withResolvers<Response>();
    const f = fixture(async (input) => {
      called.resolve(input);
      return reply.promise;
    });
    let unrelatedClosed = 0;
    try {
      const fd = f.open();
      const alias = f.descriptors.duplicate(fd, 10);
      expect(f.imports.net_close(fd)).toBe(0);
      const other = f.descriptors.register({
        ready: () => ({ bytes: 0n }),
        subscribe: () => () => undefined,
        close: () => {
          unrelatedClosed++;
        },
      });
      const reused = f.descriptors.duplicate(other, fd);
      expect(reused).toBe(fd);
      expect(f.send(alias, request)).toBe(0);
      const input = await called.promise;
      const resource = f.descriptors.resource(alias);
      const disposing = f.host.dispose();
      expect(input.signal.aborted).toBe(true);
      reply.resolve(new Response());
      await disposing;
      expect(resource.ready("read")).toEqual({ bytes: 0n, hangup: true });
      expect(unrelatedClosed).toBe(0);
      expect(f.descriptors.resource(reused)).toBe(f.descriptors.resource(other));
      expect(f.imports.net_recv(alias, OUTPUT, 10, 0, 24)).toBe(8);
      f.descriptors.close(alias);
    } finally {
      reply.resolve(new Response());
      await f.close();
    }
  });

  it("isolates socket identity between hosts sharing one descriptor table", async () => {
    const f = fixture();
    const other = new KernelHttpNetworkHost({
      memory: () => f.memory,
      descriptors: f.descriptors,
      signal: f.abort.signal,
      fetch: async () => new Response(),
    });
    try {
      const fd = f.open();
      expect(other.imports.net_validate_socket(fd)).toBe(57);
      expect(other.imports.net_close(fd)).toBe(57);
      expect(f.imports.net_validate_socket(fd)).toBe(0);
      expect(f.imports.net_validate_socket(-1)).toBe(8);
      expect(f.imports.net_validate_socket(12345)).toBe(8);
    } finally {
      await other.dispose();
      await f.close();
    }
  });

  it("rejects a registry identity mismatch without closing the unrelated fd", async () => {
    const f = fixture();
    let closed = 0;
    const unrelated = f.descriptors.register({
      ready: () => ({ bytes: 0n }),
      subscribe: () => () => undefined,
      close: () => {
        closed++;
      },
    });
    const host = new KernelHttpNetworkHost({
      memory: () => f.memory,
      signal: f.abort.signal,
      fetch: async () => new Response(),
      descriptors: {
        table: f.descriptors.table,
        wakes: f.descriptors.wakes,
        register: () => unrelated,
        resource: (fd) => f.descriptors.resource(fd),
        close: (fd) => f.descriptors.close(fd),
      },
    });
    try {
      expect(host.imports.net_socket(1, 6, 0, 16)).toBe(29);
      expect(closed).toBe(0);
      expect(f.descriptors.resource(unrelated).ready("read")).toEqual({ bytes: 0n });
    } finally {
      await host.dispose();
      await f.close();
    }
  });

  it("checks wasm bounds before descriptor allocation, send or receive consumption, and tolerates growth", async () => {
    const reply = Promise.withResolvers<Response>();
    const called = Promise.withResolvers<void>();
    const f = fixture(async () => {
      called.resolve();
      return reply.promise;
    });
    try {
      const entries = Array.from(f.filesystem.descriptors.entries()).length;
      expect(f.imports.net_socket(1, 6, 0, -1)).toBe(21);
      expect(Array.from(f.filesystem.descriptors.entries())).toHaveLength(entries);
      const fd = f.open();
      expect(f.imports.net_send(fd, 0xfffffff0, 1024, 0, 20)).toBe(21);
      expect(f.send(fd, request)).toBe(0);
      await called.promise;
      f.memory.grow(1);
      reply.resolve(new Response("grown-memory"));
      await readable(f.descriptors.resource(fd));
      expect(f.imports.net_recv(fd, OUTPUT, 32, 0, -1)).toBe(21);
      const response = await f.receive(fd);
      expect(decoder.decode(response)).toContain("grown-memory");
      expect(f.imports.net_recv(fd, OUTPUT, 0, 1, 24)).toBe(58);
    } finally {
      await f.close();
    }
  });
});
