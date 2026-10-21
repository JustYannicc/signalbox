// @effect-diagnostics nodeBuiltinImport:off - DNS address validation and option constants use platform Node APIs.
import * as NodeNet from "node:net";
import * as NodeDns from "node:dns";
import { dnsError, invalid, unsupported } from "./errors.ts";
import type { createResolverClass } from "./resolver.ts";
import type { DnsHost } from "./transport.ts";

type Order = "verbatim" | "ipv4first" | "ipv6first";
type Address = NodeDns.LookupAddress;

export function createLookup(
  resolver: InstanceType<ReturnType<typeof createResolverClass>>,
  host: DnsHost,
) {
  let order: Order = "verbatim";
  const validOrder = (value: string): Order => {
    if (value !== "verbatim" && value !== "ipv4first" && value !== "ipv6first")
      invalid("order", value);
    return value;
  };
  const optionsFor = (input: number | NodeDns.LookupOptions = {}) => {
    const options = typeof input === "number" ? { family: input } : input;
    const family =
      options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : (options.family ?? 0);
    if (family !== 0 && family !== 4 && family !== 6) invalid("family", family);
    if (options.all !== undefined && typeof options.all !== "boolean") invalid("all", options.all);
    if (options.verbatim !== undefined && typeof options.verbatim !== "boolean")
      invalid("verbatim", options.verbatim);
    const hints = options.hints ?? 0;
    if (
      !Number.isInteger(hints) ||
      hints < 0 ||
      hints > 0x7fffffff ||
      (hints & ~(NodeDns.ADDRCONFIG | NodeDns.ALL | NodeDns.V4MAPPED)) !== 0
    )
      invalid("hints", hints);
    if (hints & NodeDns.ADDRCONFIG) unsupported("getaddrinfo ADDRCONFIG");
    const resultOrder =
      options.order === undefined
        ? options.verbatim === undefined
          ? order
          : options.verbatim
            ? "verbatim"
            : "ipv4first"
        : validOrder(options.order);
    return { family, all: options.all ?? false, hints, order: resultOrder };
  };
  const hosts = (hostname: string): Address[] => {
    const addresses: Address[] = [];
    let text = "";
    try {
      text = host.readHosts?.() ?? "";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    for (const line of text.split("\n")) {
      const [address, ...names] = line.split("#")[0]!.trim().split(/\s+/);
      if (address && names.some((name) => name.toLowerCase() === hostname.toLowerCase())) {
        const family = NodeNet.isIP(address);
        if (family) addresses.push({ address, family });
      }
    }
    if (addresses.length === 0 && hostname.toLowerCase().replace(/\.$/, "") === "localhost") {
      return [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ];
    }
    return addresses;
  };
  const records = async (hostname: string, family: 4 | 6): Promise<Address[]> => {
    try {
      return (await (family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname))).map(
        (address) => ({ address, family }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENODATA" || error.code === "ENOTFOUND")
      )
        return [];
      throw error;
    }
  };
  const lookupAll = async (hostname: string, options: ReturnType<typeof optionsFor>) => {
    if (typeof hostname !== "string" && hostname !== null && hostname !== undefined)
      invalid("hostname", hostname);
    if (!hostname) return [];
    const literal = NodeNet.isIP(hostname);
    if (literal) return [{ address: hostname, family: literal }];
    let addresses = hosts(hostname);
    if (addresses.length === 0) {
      // Separate A/AAAA queries have no shared OS ordering. Verbatim preserves A then AAAA.
      const results = await Promise.allSettled([
        options.family !== 6 || options.hints & NodeDns.V4MAPPED
          ? records(hostname, 4)
          : Promise.resolve([]),
        options.family !== 4 ? records(hostname, 6) : Promise.resolve([]),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        const error = failed.reason;
        const code =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "ESERVFAIL";
        throw dnsError(
          code === "ESERVFAIL" || code === "ETIMEOUT" ? "EAI_AGAIN" : code,
          "getaddrinfo",
          hostname,
        );
      }
      addresses = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    }
    if (options.family === 6 && options.hints & NodeDns.V4MAPPED) {
      const ipv6 = addresses.filter((item) => item.family === 6);
      addresses =
        ipv6.length > 0 && !(options.hints & NodeDns.ALL)
          ? ipv6
          : addresses.map((item) =>
              item.family === 4 ? { address: `::ffff:${item.address}`, family: 6 } : item,
            );
    }
    if (options.family) addresses = addresses.filter((item) => item.family === options.family);
    if (options.order !== "verbatim") {
      const first = options.order === "ipv4first" ? 4 : 6;
      addresses.sort((a, b) => Number(b.family === first) - Number(a.family === first));
    }
    if (!addresses.length) throw dnsError("ENOTFOUND", "getaddrinfo", hostname);
    return addresses;
  };
  function lookup(hostname: string, options: NodeDns.LookupAllOptions): Promise<Address[]>;
  function lookup(hostname: string, options?: number | NodeDns.LookupOneOptions): Promise<Address>;
  function lookup(
    hostname: string,
    input?: number | NodeDns.LookupOptions,
  ): Promise<Address | Address[]>;
  async function lookup(hostname: string, input?: number | NodeDns.LookupOptions) {
    const options = optionsFor(input);
    const result = await lookupAll(hostname, options);
    return options.all
      ? result
      : (result[0] ?? { address: null, family: options.family === 6 ? 6 : 4 });
  }
  return {
    lookup,
    optionsFor,
    getDefaultResultOrder: () => order,
    setDefaultResultOrder: (value: Order) => {
      order = validOrder(value);
    },
  };
}
