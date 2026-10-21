// @effect-diagnostics nodeBuiltinImport:off - These are Node's public DNS record types.
import type * as NodeDns from "node:dns";
import { dnsError, invalid, unsupported, validateHostname } from "./errors.ts";
import { parseRecord, recordTypes, reverseName, type RecordType } from "./records.ts";
import { resolverOptions, type createDnsTransport } from "./transport.ts";

type Results = {
  A: string[];
  AAAA: string[];
  CAA: NodeDns.CaaRecord[];
  CNAME: string[];
  MX: NodeDns.MxRecord[];
  NAPTR: NodeDns.NaptrRecord[];
  NS: string[];
  PTR: string[];
  SOA: NodeDns.SoaRecord;
  SRV: NodeDns.SrvRecord[];
  TLSA: NodeDns.TlsaRecord[];
  TXT: string[][];
  ANY: NodeDns.AnyRecord[];
};

export function createResolverClass(transport: ReturnType<typeof createDnsTransport>) {
  return class Resolver {
    #controller = new AbortController();
    #options: ReturnType<typeof resolverOptions>;
    constructor(options?: { timeout?: number; tries?: number }) {
      this.#options = resolverOptions(options);
    }
    cancel() {
      this.#controller.abort();
      this.#controller = new AbortController();
    }
    getServers() {
      return ["1.1.1.1", "1.0.0.1"];
    }
    setServers(_servers: readonly string[]) {
      return unsupported("dns.setServers");
    }
    setLocalAddress(_ipv4?: string, _ipv6?: string) {
      return unsupported("dns.setLocalAddress");
    }
    async #query(hostname: string, type: RecordType) {
      validateHostname(hostname);
      const signal = this.#controller.signal;
      for (let attempt = 1; ; attempt++) {
        try {
          return await transport.query(hostname, type, signal, this.#options.timeout);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ETIMEOUT" ||
            attempt >= this.#options.tries
          )
            throw error;
        }
      }
    }
    async resolve<T extends RecordType = "A">(
      hostname: string,
      rrtype: T = "A" as T,
    ): Promise<Results[T]> {
      if (!Object.hasOwn(recordTypes, rrtype)) invalid("rrtype", rrtype);
      const answers = await this.#query(hostname, rrtype);
      const parsed = answers.map((answer) => {
        const record = parseRecord(answer, hostname, `query${rrtype}`);
        if (rrtype === "ANY") {
          const type = Object.entries(recordTypes).find(([, value]) => value === answer.type)?.[0];
          if (!type || type === "ANY") throw dnsError("ENOTIMP", "queryANY", hostname);
          if (typeof record === "string") return { type, value: record };
          if (Array.isArray(record)) return { type, entries: record };
          return { type, ...record };
        }
        return (rrtype === "A" || rrtype === "AAAA") &&
          typeof record === "object" &&
          "address" in record
          ? record.address
          : record;
      });
      // The dispatch and presentation parser above establish the record type selected by rrtype.
      return (rrtype === "SOA" ? parsed[0] : parsed) as Results[T];
    }
    async #addresses(hostname: string, type: "A" | "AAAA", options?: NodeDns.ResolveOptions) {
      const answers = await this.#query(hostname, type);
      return answers.map((answer) => {
        const record = parseRecord(answer, hostname, `query${type}`);
        if (typeof record !== "object" || !("address" in record))
          throw dnsError("EBADRESP", `query${type}`, hostname);
        return options?.ttl ? record : record.address;
      });
    }
    resolve4(
      hostname: string,
      options: NodeDns.ResolveWithTtlOptions,
    ): Promise<NodeDns.RecordWithTtl[]>;
    resolve4(hostname: string, options?: NodeDns.ResolveOptions): Promise<string[]>;
    resolve4(hostname: string, options?: NodeDns.ResolveOptions) {
      return this.#addresses(hostname, "A", options);
    }
    resolve6(
      hostname: string,
      options: NodeDns.ResolveWithTtlOptions,
    ): Promise<NodeDns.RecordWithTtl[]>;
    resolve6(hostname: string, options?: NodeDns.ResolveOptions): Promise<string[]>;
    resolve6(hostname: string, options?: NodeDns.ResolveOptions) {
      return this.#addresses(hostname, "AAAA", options);
    }
    resolveAny(hostname: string) {
      return this.resolve(hostname, "ANY");
    }
    resolveCaa(hostname: string) {
      return this.resolve(hostname, "CAA");
    }
    resolveCname(hostname: string) {
      return this.resolve(hostname, "CNAME");
    }
    resolveMx(hostname: string) {
      return this.resolve(hostname, "MX");
    }
    resolveNaptr(hostname: string) {
      return this.resolve(hostname, "NAPTR");
    }
    resolveNs(hostname: string) {
      return this.resolve(hostname, "NS");
    }
    resolvePtr(hostname: string) {
      return this.resolve(hostname, "PTR");
    }
    resolveSoa(hostname: string) {
      return this.resolve(hostname, "SOA");
    }
    resolveSrv(hostname: string) {
      return this.resolve(hostname, "SRV");
    }
    resolveTlsa(hostname: string) {
      return this.resolve(hostname, "TLSA");
    }
    resolveTxt(hostname: string) {
      return this.resolve(hostname, "TXT");
    }
    reverse(ip: string) {
      return this.resolve(reverseName(ip), "PTR");
    }
  };
}
