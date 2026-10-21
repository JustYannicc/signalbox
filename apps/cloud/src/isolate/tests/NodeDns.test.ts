import * as NodeUtil from "node:util";
import * as NodeDns from "node:dns";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeDns } from "../NodeDns.ts";

const a = { name: "example.test.", type: 1, TTL: 60, data: "192.0.2.1" };
const aaaa = { ...a, type: 28, data: "2001:db8::1" };
function fixture(
  answer: (type: number, name: string) => object = (type) => ({
    Status: 0,
    Answer: [type === 1 ? a : aaaa],
  }),
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (resource) => {
    const url = new URL(String(resource));
    return Response.json(
      answer(Number(url.searchParams.get("type")), url.searchParams.get("name")!),
    );
  });
  const modules = createNodeDns({ fetch });
  return { ...modules, promises: modules["dns/promises"], fetch };
}

describe("Node DNS lookup", () => {
  it("queries both families and preserves configured ordering across promise and callback exports", async () => {
    const f = fixture();
    expect(await f.promises.lookup("example.test", { all: true })).toEqual([
      { address: a.data, family: 4 },
      { address: aaaa.data, family: 6 },
    ]);
    f.dns.setDefaultResultOrder("ipv6first");
    expect(f.promises.getDefaultResultOrder()).toBe("ipv6first");
    expect(await f.promises.lookup("example.test")).toEqual({ address: aaaa.data, family: 6 });
    expect(await f.promises.lookup("example.test", { order: "ipv4first", verbatim: true })).toEqual(
      { address: a.data, family: 4 },
    );
    expect(await f.promises.lookup("example.test", { verbatim: false })).toEqual({
      address: a.data,
      family: 4,
    });
    expect(await f.promises.lookup("example.test", 6)).toEqual({ address: aaaa.data, family: 6 });
    expect(await f.promises.lookup("example.test", { family: "IPv4" })).toEqual({
      address: a.data,
      family: 4,
    });
  });
  it("does not query IP literals, localhost, or kernel hosts entries", async () => {
    const f = fixture();
    expect(await f.promises.lookup("127.0.0.2", { family: 6 })).toEqual({
      address: "127.0.0.2",
      family: 4,
    });
    expect(await f.promises.lookup("::1", { all: true })).toEqual([{ address: "::1", family: 6 }]);
    expect(await f.promises.lookup("localhost", { family: 6 })).toEqual({
      address: "::1",
      family: 6,
    });
    const local = createNodeDns({
      fetch: f.fetch,
      readHosts: () => "192.0.2.7 buildbox alias # comment\n2001:db8::7 buildbox\n",
    });
    expect(await local.dns.promises.lookup("alias")).toEqual({ address: "192.0.2.7", family: 4 });
    expect(await local.dns.promises.lookup("BUILDBOX", { family: 6 })).toEqual({
      address: "2001:db8::7",
      family: 6,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("calls literal lookup callbacks asynchronously with address and family", async () => {
    const f = fixture();
    let synchronous = true;
    const result = new Promise<unknown[]>((resolve, reject) => {
      f.dns.lookup("127.0.0.1", {}, (...args: unknown[]) => {
        try {
          expect(synchronous).toBe(false);
          resolve(args);
        } catch (error) {
          reject(error);
        }
      });
    });
    synchronous = false;
    expect(await result).toEqual([null, "127.0.0.1", 4]);
  });
  it.each([3, 0])(
    "maps NXDOMAIN or empty answers to getaddrinfo ENOTFOUND, status %s",
    async (Status) => {
      const f = fixture(() => ({ Status, Answer: [] }));
      await expect(f.promises.lookup("missing.test")).rejects.toMatchObject({
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
        hostname: "missing.test",
      });
    },
  );
  it("keeps SERVFAIL distinct even when the other family succeeds", async () => {
    const f = fixture((type) => (type === 1 ? { Status: 0, Answer: [a] } : { Status: 2 }));
    await expect(f.promises.lookup("broken.test")).rejects.toMatchObject({
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    });
  });
  it("returns the surviving family for an empty family and implements IPv4 mapping", async () => {
    const f = fixture((type) => ({ Status: 0, Answer: type === 1 ? [a] : [] }));
    expect(await f.promises.lookup("v4.test")).toEqual({ address: a.data, family: 4 });
    expect(await f.promises.lookup("v4.test", { family: 6, hints: NodeDns.V4MAPPED })).toEqual({
      address: `::ffff:${a.data}`,
      family: 6,
    });
  });
  it("validates options and states unsupported interface/service behavior", async () => {
    const f = fixture();
    await expect(f.promises.lookup("test", { family: 3 })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_VALUE",
    });
    await expect(f.promises.lookup("test", { hints: NodeDns.ADDRCONFIG })).rejects.toMatchObject({
      code: "ENOTSUP",
    });
    await expect(f.promises.lookupService("127.0.0.1", 80)).rejects.toMatchObject({
      code: "ENOTSUP",
      syscall: "getnameinfo",
    });
    expect(() => f.dns.setServers(["8.8.8.8"])).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("Node DNS records and resolvers", () => {
  it("resolves generic A/AAAA and TTL-aware records with a real DoH request", async () => {
    const f = fixture();
    expect(await f.promises.resolve("example.test")).toEqual([a.data]);
    expect(await f.promises.resolve("example.test", "AAAA")).toEqual([aaaa.data]);
    expect(await f.promises.resolve4("example.test", { ttl: true })).toEqual([
      { address: a.data, ttl: 60 },
    ]);
    expect(await f.promises.resolve6("example.test", { ttl: true })).toEqual([
      { address: aaaa.data, ttl: 60 },
    ]);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://cloudflare-dns.com/dns-query?name=example.test&type=1");
    expect(init?.headers).toEqual({ accept: "application/dns-json" });
  });
  it.each([
    [2, "NS", "ns.example.test.", "ns.example.test"],
    [5, "CNAME", "alias.example.test.", "alias.example.test"],
    [12, "PTR", "ptr.example.test.", "ptr.example.test"],
    [15, "MX", "10 mail.example.test.", { priority: 10, exchange: "mail.example.test" }],
    [16, "TXT", '"one chunk" "two\\032chunks"', ["one chunk", "two chunks"]],
    [
      33,
      "SRV",
      "1 2 443 service.example.test.",
      { priority: 1, weight: 2, port: 443, name: "service.example.test" },
    ],
    [
      35,
      "NAPTR",
      '10 20 "S" "SIP+D2U" "" _sip._udp.example.test.',
      {
        order: 10,
        preference: 20,
        flags: "S",
        service: "SIP+D2U",
        regexp: "",
        replacement: "_sip._udp.example.test",
      },
    ],
    [257, "CAA", '0 issue "letsencrypt.org"', { critical: 0, issue: "letsencrypt.org" }],
  ] as const)("decodes %s/%s records", async (type, rrtype, data, expected) => {
    const f = fixture(() => ({ Status: 0, Answer: [{ ...a, type, data }] }));
    expect(await f.promises.resolve("example.test", rrtype)).toEqual([expected]);
  });
  it("decodes TLSA certificate bytes through both entry points", async () => {
    const f = fixture(() => ({ Status: 0, Answer: [{ ...a, type: 52, data: "3 1 1 00aBff" }] }));
    const expected = [
      { certUsage: 3, selector: 1, match: 1, data: new Uint8Array([0, 171, 255]).buffer },
    ];
    expect(await f.promises.resolveTlsa("_443._tcp.example.test")).toEqual(expected);
    expect(await f.promises.resolve("_443._tcp.example.test", "TLSA")).toEqual(expected);
  });
  it("preserves the multi-value promisified lookup contract", async () => {
    const f = fixture();
    expect(await NodeUtil.promisify(f.dns.lookup)("127.0.0.1")).toEqual({
      address: "127.0.0.1",
      family: 4,
    });
  });
  it("decodes SOA and mixed ANY answers", async () => {
    const soa = { ...a, type: 6, data: "ns.example.test. hostmaster.example.test. 1 2 3 4 5" };
    const f = fixture(() => ({ Status: 0, Answer: [soa] }));
    expect(await f.promises.resolveSoa("example.test")).toEqual({
      nsname: "ns.example.test",
      hostmaster: "hostmaster.example.test",
      serial: 1,
      refresh: 2,
      retry: 3,
      expire: 4,
      minttl: 5,
    });
    const mixed = fixture(() => ({
      Status: 0,
      Answer: [a, aaaa, { ...a, type: 16, data: '"hello"' }],
    }));
    expect(await mixed.promises.resolveAny("example.test")).toEqual([
      { type: "A", address: a.data, ttl: 60 },
      { type: "AAAA", address: aaaa.data, ttl: 60 },
      { type: "TXT", entries: ["hello"] },
    ]);
  });
  it.each([
    ["192.0.2.1", "1.2.0.192.in-addr.arpa"],
    ["::1", `${"1" + "0".repeat(31)}`.split("").join(".") + ".ip6.arpa"],
  ])("reverses %s", async (ip, name) => {
    const f = fixture(() => ({ Status: 0, Answer: [{ ...a, type: 12, data: "host.test." }] }));
    expect(await f.promises.reverse(ip!)).toEqual(["host.test"]);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("name")).toBe(name);
  });
  it.each([
    [3, "ENOTFOUND"],
    [2, "ESERVFAIL"],
    [5, "EREFUSED"],
    [0, "ENODATA"],
  ])("keeps resolver status %s as %s", async (Status, code) => {
    const f = fixture(() => ({ Status, Answer: [] }));
    await expect(f.promises.resolve4("missing.test")).rejects.toMatchObject({
      code,
      syscall: "queryA",
      hostname: "missing.test",
    });
  });
  it("rejects invalid JSON shapes and invalid address records", async () => {
    const invalid = fixture(() => ({ Status: "0" }));
    await expect(invalid.promises.resolve4("bad.test")).rejects.toMatchObject({ code: "EBADRESP" });
    const malformed = fixture(() => ({ Status: 0, Answer: [{ ...a, data: "garbage" }] }));
    await expect(malformed.promises.resolve4("bad.test")).rejects.toMatchObject({
      code: "EBADRESP",
    });
  });
  it("provides generic callback resolve on independent Resolver instances", async () => {
    const f = fixture();
    const resolver = new f.dns.Resolver();
    const result = new Promise((resolve, reject) => {
      resolver.resolve("example.test", "AAAA", (error: Error | null, addresses: unknown) =>
        error ? reject(error) : resolve(addresses),
      );
    });
    expect(await result).toEqual([aaaa.data]);
    expect(new f.promises.Resolver().getServers()).toEqual(f.dns.getServers());
  });
});
