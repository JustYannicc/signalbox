// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Agents report bounded native diagnostics and wrap the platform HTTP client and retain its native stream lifecycle.
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import { NodeBuiltinUnsupportedError } from "./NodeBuiltinFailure.ts";
import { networkError } from "./node/network/errors.ts";
import { FetchClientRequest } from "./node/network/FetchClientRequest.ts";
import { parseHttpRequest } from "./node/network/HttpClient.ts";
import {
  createProxyHttpTransport,
  loadPreparedProxyClient,
  proxyAgentOptions,
  validateProxyClient,
} from "./node/network/ProxyHttpTransport.ts";
import type { ProxyClientModule } from "./node/network/ProxyHttpTransport.ts";

type AgentRequest = NodeHttp.ClientRequest | FetchClientRequest;
import { registerHttpAgentRuntime } from "./node/network/HttpAgentRuntime.ts";
export { configureNodeHttpAgents, drainNodeHttpAgents } from "./node/network/HttpAgentRuntime.ts";

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
  loadProxyClient: () => ProxyClientModule = loadPreparedProxyClient,
) {
  let reportedCa = false;
  let reportedConnections = false;
  const agents = new WeakMap<
    object,
    {
      readonly protocol: string;
      readonly options: Record<string, unknown>;
      readonly requests: Set<AgentRequest>;
    }
  >();
  let draining = false;
  const active = new Set<AgentRequest>();
  const closed = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];
  const instrumentedProxies = new WeakSet<object>();
  const validate = (builtin: string, options: Record<string, unknown>, allowLookup = false) => {
    for (const name of unsupportedOptions) {
      if (options[name] !== undefined && !(name === "lookup" && allowLookup))
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
  const runtime = {
    configure(resolveClient: () => unknown) {
      loadProxyClient = () => validateProxyClient(resolveClient());
    },
    async drain() {
      // Cancellation callbacks can retry before close. Close admission before taking the join set.
      draining = true;
      for (const request of active)
        request.destroy(networkError("ECONNRESET", "Harness stopped the request"));
      await Promise.all(closed);
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, "HTTP Agent cleanup failed");
    },
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
        validate(`${protocol}.Agent`, options, true);
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
        for (const request of state.requests)
          request.destroy(networkError("ECONNRESET", "Agent destroyed the request"));
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
        "Agents apply TLS policy, dispatch through the platform HTTP/fetch client, and cancel active requests on destroy. CA and connection options are recorded metadata; platform trust and pooling apply. Proxy Agents retain their CONNECT routing, authorization and DNS behavior through the prepared Undici client. Client certificates and verification overrides throw named errors.",
    };
    markNodeBuiltinCapability(Agent, capability);
    const globalAgent = new Agent();
    const request = markNodeBuiltinCapability((...args: unknown[]): AgentRequest => {
      if (draining) throw networkError("ECONNRESET", "Harness is draining HTTP requests");
      const { options, callback } = requestArguments(args);
      const agent = options.agent === false ? new Agent() : (options.agent ?? globalAgent);
      if (typeof agent !== "object" || agent === null)
        throw new NodeBuiltinUnsupportedError(`${protocol}.request custom Agent`);
      const proxy = proxyAgentOptions(agent);
      let state = agents.get(agent);
      if (!proxy && (!state || agent.constructor !== Agent))
        throw new NodeBuiltinUnsupportedError(`${protocol}.request custom Agent`);
      if (
        !proxy &&
        (state!.protocol !== `${protocol}:` ||
          (options.protocol !== undefined && options.protocol !== state!.protocol))
      )
        throw new TypeError(`HTTP Agent requires protocol ${protocol}:`);
      const agentOptions: unknown = Reflect.get(agent, "options");
      if (typeof agentOptions !== "object" || agentOptions === null)
        throw new TypeError("HTTP Agent options must be an object");
      if (!state) {
        state = {
          protocol: `${protocol}:`,
          options: agentOptions as Record<string, unknown>,
          requests: new Set(),
        };
        agents.set(agent, state);
      }
      if (proxy && !instrumentedProxies.has(agent)) {
        const destroy: unknown = Reflect.get(agent, "destroy");
        if (typeof destroy !== "function")
          throw new NodeBuiltinUnsupportedError(`${protocol}.Agent proxy destroy`);
        const requests = state.requests;
        Object.defineProperty(agent, "destroy", {
          configurable: true,
          writable: true,
          value: (...destroyArgs: unknown[]) => {
            for (const request of requests)
              request.destroy(networkError("ECONNRESET", "Agent destroyed the request"));
            return Reflect.apply(destroy, agent, destroyArgs);
          },
        });
        instrumentedProxies.add(agent);
      }
      const transportOptions: Record<string, unknown> = {
        ...agentOptions,
        ...options,
        protocol: options.protocol ?? `${protocol}:`,
        agent: false,
      };
      validate(`${protocol}.request`, transportOptions, proxy !== undefined);
      delete transportOptions.ca;
      delete transportOptions.rejectUnauthorized;
      for (const name of connectionOptions) delete transportOptions[name];
      let result: AgentRequest;
      if (proxy) {
        const parsed = parseHttpRequest([transportOptions, callback], protocol);
        if (!parsed) throw new TypeError("Invalid proxy HTTP request options");
        const transport = createProxyHttpTransport(
          agent,
          proxy,
          transportOptions,
          (value) => validate(`${protocol}.Agent proxy`, value, true),
          loadProxyClient,
        );
        result = new FetchClientRequest({
          parsed: { ...parsed, options: { ...parsed.options, agent } },
          fallbackAgent: agent,
          dispatch: transport.dispatch,
          dispose: async () => {
            try {
              await transport.dispose();
            } catch (error) {
              cleanupErrors.push(error);
              throw error;
            }
          },
        });
      } else {
        // Workerd's native client sends through fetch; its inert addRequest is never used.
        result = Reflect.apply(nativeRequest, module, [
          transportOptions,
          callback,
        ]) as NodeHttp.ClientRequest;
      }
      state.requests.add(result);
      active.add(result);
      const requests = state.requests;
      const closure = new Promise<void>((resolve) =>
        result.once("close", () => {
          requests.delete(result);
          active.delete(result);
          resolve();
        }),
      );
      closed.add(closure);
      void closure.then(() => closed.delete(closure));
      return result;
    }, capability);
    registerHttpAgentRuntime(request, runtime);
    const get = markNodeBuiltinCapability((...args: unknown[]) => {
      const result = request(...args);
      result.end();
      return result;
    }, capability);
    return { Agent, globalAgent, request, get };
  };
  return { http: create("http"), https: create("https") };
}
