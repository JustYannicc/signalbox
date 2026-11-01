// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Agents report bounded native diagnostics and wrap the platform HTTP client and retain its native stream lifecycle.
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import { NodeBuiltinUnsupportedError } from "./NodeBuiltinFailure.ts";

const unsupportedOptions = [
  "cert",
  "key",
  "pfx",
  "passphrase",
  "checkServerIdentity",
  "crl",
  "ciphers",
  "sigalgs",
  "dhparam",
  "ecdhCurve",
  "minVersion",
  "maxVersion",
  "secureOptions",
  "session",
  "sessionIdContext",
  "clientCertEngine",
  "privateKeyEngine",
  "privateKeyIdentifier",
  "ALPNProtocols",
  "secureContext",
  "servername",
  "socketPath",
  "createConnection",
  "lookup",
  "proxy",
  "proxyEnv",
  "proxyUrl",
  "httpProxy",
  "httpsProxy",
  "noProxy",
  "insecureHTTPParser",
] as const;
const connectionOptions = [
  "keepAlive",
  "keepAliveMsecs",
  "maxSockets",
  "maxTotalSockets",
  "maxFreeSockets",
  "scheduling",
  "agentKeepAliveTimeoutBuffer",
] as const;

type RequestCallback = (response: unknown) => void;

function requestArguments(args: readonly unknown[]) {
  const [input, second, third] = args;
  let options: Record<string, unknown>;
  if (typeof input === "string" || input instanceof URL) {
    options = { ...NodeURL.urlToHttpOptions(new URL(String(input))) };
    if (typeof second === "object" && second !== null) Object.assign(options, second);
  } else if (typeof input === "object" && input !== null) options = { ...input };
  else throw new TypeError("HTTP request requires a URL or options");
  const callback = typeof second === "function" ? second : third;
  if (callback !== undefined && typeof callback !== "function")
    throw new TypeError("HTTP response callback must be a function");
  return { options, callback: callback as RequestCallback | undefined };
}

/** One realm owns these agents, their diagnostics, and the platform clients they wrap. */
export function createNodeHttpAgentModules(
  native: Readonly<Record<"http" | "https", object>>,
  diagnostic: (message: string) => void = (message) => globalThis.console.warn(message),
) {
  let reportedCa = false;
  let reportedConnections = false;
  const agents = new WeakMap<
    object,
    {
      readonly protocol: string;
      readonly options: Record<string, unknown>;
      readonly requests: Set<NodeHttp.ClientRequest>;
    }
  >();
  const validate = (builtin: string, options: Record<string, unknown>) => {
    for (const name of unsupportedOptions) {
      if (options[name] !== undefined)
        throw new NodeBuiltinUnsupportedError(`${builtin} option ${name}`);
    }
    if (options.rejectUnauthorized !== undefined && options.rejectUnauthorized !== true)
      throw new NodeBuiltinUnsupportedError(`${builtin} option rejectUnauthorized`);
    if (options.ca !== undefined && !reportedCa) {
      reportedCa = true;
      diagnostic("CA policy supplied, platform trust enforced");
    }
    if (connectionOptions.some((name) => options[name] !== undefined) && !reportedConnections) {
      reportedConnections = true;
      diagnostic(
        "HTTP Agent connection options are metadata; platform fetch controls pooling and connection limits",
      );
    }
  };
  const create = (protocol: "http" | "https") => {
    const module = native[protocol];
    const nativeRequest: unknown = Reflect.get(module, "request");
    if (typeof nativeRequest !== "function") throw new TypeError(`Missing ${protocol}.request`);
    class Agent extends NodeEvents.EventEmitter {
      readonly protocol = `${protocol}:`;
      readonly defaultPort = protocol === "https" ? 443 : 80;
      readonly options: Record<string, unknown>;
      readonly keepAlive: boolean;
      readonly maxSockets: number;
      readonly maxFreeSockets: number;
      readonly maxTotalSockets: number;
      readonly keepAliveMsecs: number;
      readonly scheduling: string;

      constructor(options: Record<string, unknown> = {}) {
        super();
        validate(`${protocol}.Agent`, options);
        // Isolate TLS uses platform trust. Supplied CA roots are metadata, and fetch owns pooling.
        this.options = { ...options };
        this.keepAlive = Boolean(options.keepAlive);
        this.maxSockets = Number(options.maxSockets ?? Infinity);
        this.maxFreeSockets = Number(options.maxFreeSockets ?? 256);
        this.maxTotalSockets = Number(options.maxTotalSockets ?? Infinity);
        this.keepAliveMsecs = Number(options.keepAliveMsecs ?? 1000);
        this.scheduling = String(options.scheduling ?? "lifo");
        agents.set(this, { protocol: this.protocol, options: this.options, requests: new Set() });
      }

      destroy(): void {
        const state = agents.get(this)!;
        for (const request of state.requests) request.destroy();
      }

      addRequest(): never {
        throw new NodeBuiltinUnsupportedError(`${protocol}.Agent.addRequest socket dispatch`);
      }

      createConnection(): never {
        throw new NodeBuiltinUnsupportedError(`${protocol}.Agent.createConnection`);
      }
    }
    const capability = {
      status: "conditional" as const,
      evidence:
        "Agents apply TLS policy, dispatch through the platform HTTP/fetch client, and cancel active requests on destroy. CA and connection options are recorded metadata; platform trust and pooling apply. Custom sockets, proxies, client certificates and verification overrides throw named errors.",
    };
    markNodeBuiltinCapability(Agent, capability);
    const globalAgent = new Agent();
    const request = markNodeBuiltinCapability((...args: unknown[]): NodeHttp.ClientRequest => {
      const { options, callback } = requestArguments(args);
      const agent = options.agent === false ? new Agent() : (options.agent ?? globalAgent);
      const state = typeof agent === "object" && agent !== null ? agents.get(agent) : undefined;
      if (!state || agent.constructor !== Agent)
        throw new NodeBuiltinUnsupportedError(`${protocol}.request custom Agent`);
      if (
        state.protocol !== `${protocol}:` ||
        (options.protocol !== undefined && options.protocol !== state.protocol)
      )
        throw new TypeError(`HTTP Agent requires protocol ${protocol}:`);
      const transportOptions: Record<string, unknown> = {
        ...state.options,
        ...options,
        protocol: state.protocol,
        agent: false,
      };
      validate(`${protocol}.request`, transportOptions);
      // The native client sends the request; never pass our policy agent to Workerd's inert addRequest.
      delete transportOptions.ca;
      delete transportOptions.rejectUnauthorized;
      for (const name of connectionOptions) delete transportOptions[name];
      const result = Reflect.apply(nativeRequest, module, [
        transportOptions,
        callback,
      ]) as NodeHttp.ClientRequest;
      state.requests.add(result);
      result.once("close", () => state.requests.delete(result));
      return result;
    }, capability);
    const get = markNodeBuiltinCapability((...args: unknown[]) => {
      const result = request(...args);
      result.end();
      return result;
    }, capability);
    return { Agent, globalAgent, request, get };
  };
  return { http: create("http"), https: create("https") };
}
