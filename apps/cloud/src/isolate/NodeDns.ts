// @effect-diagnostics nodeBuiltinImport:off - Preserve the platform DNS constants and Node callback types.
import * as NodeDns from "node:dns";
import { createDnsTransport, type DnsHost } from "./node/dns/transport.ts";
import { createResolverClass } from "./node/dns/resolver.ts";
import { createLookup } from "./node/dns/lookup.ts";
import { invalid, unsupported } from "./node/dns/errors.ts";

export type { DnsHost } from "./node/dns/transport.ts";

type Callback = (error: Error | null, result?: unknown) => void;
const methods = [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
] as const;
function callback(value: unknown): asserts value is Callback {
  if (typeof value !== "function") invalid("callback", value);
}

/** Owns DNS requests for one guest, including resolver instances created by that guest. */
export function createNodeDns(host: DnsHost = { fetch: globalThis.fetch.bind(globalThis) }) {
  const transport = createDnsTransport(host);
  const PromiseResolver = createResolverClass(transport);
  const resolver = new PromiseResolver();
  const lookup = createLookup(resolver, host);
  const promises = {
    Resolver: PromiseResolver,
    lookup: lookup.lookup,
    lookupService: async (_address: string, _port: number) => unsupported("getnameinfo"),
    getDefaultResultOrder: lookup.getDefaultResultOrder,
    setDefaultResultOrder: lookup.setDefaultResultOrder,
    getServers: () => resolver.getServers(),
    setServers: (servers: readonly string[]) => resolver.setServers(servers),
    resolve: resolver.resolve.bind(resolver),
    resolve4: resolver.resolve4.bind(resolver),
    resolve6: resolver.resolve6.bind(resolver),
    resolveAny: resolver.resolveAny.bind(resolver),
    resolveCaa: resolver.resolveCaa.bind(resolver),
    resolveCname: resolver.resolveCname.bind(resolver),
    resolveMx: resolver.resolveMx.bind(resolver),
    resolveNaptr: resolver.resolveNaptr.bind(resolver),
    resolveNs: resolver.resolveNs.bind(resolver),
    resolvePtr: resolver.resolvePtr.bind(resolver),
    resolveSoa: resolver.resolveSoa.bind(resolver),
    resolveSrv: resolver.resolveSrv.bind(resolver),
    resolveTlsa: resolver.resolveTlsa.bind(resolver),
    resolveTxt: resolver.resolveTxt.bind(resolver),
    reverse: resolver.reverse.bind(resolver),
  };
  const invoke = (
    target: InstanceType<typeof PromiseResolver>,
    name: (typeof methods)[number],
    args: unknown[],
  ) => {
    const cb = args.pop();
    callback(cb);
    const operation = Reflect.apply(target[name], target, args) as Promise<unknown>;
    void operation.then(
      (result) => cb(null, result),
      (error: Error) => cb(error),
    );
  };
  const callbackMethods = (target: InstanceType<typeof PromiseResolver>) =>
    Object.fromEntries(
      methods.map((name) => [name, (...args: unknown[]) => invoke(target, name, args)]),
    );
  class Resolver {
    #resolver: InstanceType<typeof PromiseResolver>;
    constructor(options?: { timeout?: number; tries?: number }) {
      this.#resolver = new PromiseResolver(options);
    }
    resolve(...args: unknown[]) {
      invoke(this.#resolver, "resolve", args);
    }
    resolve4(...args: unknown[]) {
      invoke(this.#resolver, "resolve4", args);
    }
    resolve6(...args: unknown[]) {
      invoke(this.#resolver, "resolve6", args);
    }
    resolveAny(...args: unknown[]) {
      invoke(this.#resolver, "resolveAny", args);
    }
    resolveCaa(...args: unknown[]) {
      invoke(this.#resolver, "resolveCaa", args);
    }
    resolveCname(...args: unknown[]) {
      invoke(this.#resolver, "resolveCname", args);
    }
    resolveMx(...args: unknown[]) {
      invoke(this.#resolver, "resolveMx", args);
    }
    resolveNaptr(...args: unknown[]) {
      invoke(this.#resolver, "resolveNaptr", args);
    }
    resolveNs(...args: unknown[]) {
      invoke(this.#resolver, "resolveNs", args);
    }
    resolvePtr(...args: unknown[]) {
      invoke(this.#resolver, "resolvePtr", args);
    }
    resolveSoa(...args: unknown[]) {
      invoke(this.#resolver, "resolveSoa", args);
    }
    resolveSrv(...args: unknown[]) {
      invoke(this.#resolver, "resolveSrv", args);
    }
    resolveTlsa(...args: unknown[]) {
      invoke(this.#resolver, "resolveTlsa", args);
    }
    resolveTxt(...args: unknown[]) {
      invoke(this.#resolver, "resolveTxt", args);
    }
    reverse(...args: unknown[]) {
      invoke(this.#resolver, "reverse", args);
    }
    cancel() {
      this.#resolver.cancel();
    }
    getServers() {
      return this.#resolver.getServers();
    }
    setServers(servers: readonly string[]) {
      this.#resolver.setServers(servers);
    }
    setLocalAddress(ipv4?: string, ipv6?: string) {
      this.#resolver.setLocalAddress(ipv4, ipv6);
    }
  }
  const dns = {
    ...NodeDns,
    ...callbackMethods(resolver),
    Resolver,
    promises,
    getDefaultResultOrder: lookup.getDefaultResultOrder,
    setDefaultResultOrder: lookup.setDefaultResultOrder,
    getServers: promises.getServers,
    setServers: promises.setServers,
    lookup(
      hostname: string,
      input: number | NodeDns.LookupOptions | Callback,
      cb?: (...args: unknown[]) => void,
    ) {
      const options = typeof input === "function" ? undefined : input;
      const done = typeof input === "function" ? input : cb;
      callback(done);
      const normalized = lookup.optionsFor(options);
      void promises.lookup(hostname, options).then(
        (result) => {
          if (normalized.all) done(null, result);
          else if (!Array.isArray(result))
            Reflect.apply(done, undefined, [null, result.address, result.family]);
        },
        (error: Error) => done(error),
      );
    },
    lookupService(_address: string, _port: number, cb: Callback) {
      callback(cb);
      void promises.lookupService(_address, _port).then(
        (result) => cb(null, result),
        (error: Error) => cb(error),
      );
    },
  };
  Object.defineProperty(dns.lookup, Symbol.for("nodejs.util.promisify.custom"), {
    value: promises.lookup,
  });
  // Native ESM namespaces carry a default export; it must not point back to the host's resolver.
  Object.defineProperty(dns, "default", { value: dns, enumerable: false });
  Object.defineProperty(promises, "default", { value: promises, enumerable: false });
  return { dns, "dns/promises": promises, drain: transport.drain };
}
