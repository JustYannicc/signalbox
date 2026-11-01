// @effect-diagnostics nodeBuiltinImport:off - The prepared Undici client parses HTTP over the proxy Agent's native socket.
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import type * as NodeNet from "node:net";
import type * as Undici from "undici";
import type { FetchClientRequest } from "./FetchClientRequest.ts";
import { createNodeSocketLifetime } from "../../NodeSocketLifetime.ts";
import { NodeBuiltinUnsupportedError } from "../../NodeBuiltinFailure.ts";

export type ProxyClientModule = Pick<typeof Undici, "Client">;

export function validateProxyClient(undici: unknown): ProxyClientModule {
  if (
    typeof undici !== "object" ||
    undici === null ||
    typeof Reflect.get(undici, "Client") !== "function"
  )
    throw new NodeBuiltinUnsupportedError("http.Agent proxy transport environment package undici");
  return undici as ProxyClientModule;
}

export function loadPreparedProxyClient(): ProxyClientModule {
  // The guest module adapter resolves the already loaded, precompiled environment package.
  const module = globalThis.process.getBuiltinModule("module");
  const require = module?.createRequire("/__signalbox_http_agent__.cjs");
  return validateProxyClient(require?.("undici"));
}

function proxyRejectionSocket(): NodeNet.Socket {
  // A denied CONNECT replays a buffered response. Undici's parser still writes headers
  // during attachment, so consume those writes on an internal stream, never the proxy.
  const socket = new NodeStream.Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return Object.assign(socket, { ref: () => socket, unref: () => socket }) as NodeNet.Socket;
}

export function proxyAgentOptions(agent: object) {
  const connect: unknown = Reflect.get(agent, "connect");
  const proxy: unknown = Reflect.get(agent, "proxy");
  const options: unknown = Reflect.get(agent, "connectOpts");
  if (
    typeof connect !== "function" ||
    !(proxy instanceof URL) ||
    typeof options !== "object" ||
    options === null
  )
    return undefined;
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
    throw new NodeBuiltinUnsupportedError("http.Agent proxy protocol");
  if (typeof Reflect.get(agent, "setRequestProps") === "function")
    throw new NodeBuiltinUnsupportedError("http.Agent forwarding proxy contract");
  return { connect, proxy, options: { ...options } as Record<string, unknown> };
}

export function createProxyHttpTransport(
  agent: object,
  proxy: NonNullable<ReturnType<typeof proxyAgentOptions>>,
  options: Record<string, unknown>,
  validate: (options: Record<string, unknown>) => void,
  loadClient: () => ProxyClientModule,
) {
  let client: Undici.Client | undefined;
  let connecting: Promise<NodeNet.Socket> | undefined;
  const lifetime = createNodeSocketLifetime();
  const connectOptions = { ...proxy.options };
  const alpn = connectOptions.ALPNProtocols;
  // HttpsProxyAgent supplies this HTTP/1.1 default. The platform owns TLS negotiation.
  if (Array.isArray(alpn) && alpn.length === 1 && alpn[0] === "http/1.1")
    delete connectOptions.ALPNProtocols;
  validate(connectOptions);
  delete connectOptions.ca;
  delete connectOptions.rejectUnauthorized;
  const receiver = Object.create(
    Object.getPrototypeOf(agent),
    Object.getOwnPropertyDescriptors(agent),
  ) as object;
  Object.defineProperty(receiver, "connectOpts", { value: connectOptions, configurable: true });
  return {
    async dispatch(request: Request, outgoing: FetchClientRequest): Promise<Response> {
      request.signal.throwIfAborted();
      const url = new URL(request.url);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const target = {
        ...options,
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        secureEndpoint: url.protocol === "https:",
        signal: request.signal,
      };
      connectOptions.signal = request.signal;
      let rejected = false;
      outgoing.once("proxyConnect", (response: { statusCode: number }) => {
        rejected = response.statusCode !== 200;
      });
      const { Client } = loadClient();
      client = new Client(url.origin, {
        allowH2: false,
        pipelining: 0,
        connect(_address, callback) {
          connecting = Promise.resolve(
            lifetime.run(() => Reflect.apply(proxy.connect, receiver, [outgoing, target])) as
              | NodeNet.Socket
              | Promise<NodeNet.Socket>,
          );
          void connecting
            .then(
              (socket) => {
                lifetime.capture(socket);
                const selected = rejected ? proxyRejectionSocket() : socket;
                if (selected !== socket) {
                  lifetime.capture(selected);
                  socket.destroy();
                  // HttpsProxyAgent checks for Node HTTP's data listener; Undici reads on readable.
                  selected.on("data", () => {});
                }
                if (request.signal.aborted) selected.destroy();
                callback(null, selected);
                outgoing.attachSocket(selected);
              },
              (error: unknown) =>
                callback(error instanceof Error ? error : new Error(String(error)), null),
            )
            .catch((error: unknown) =>
              outgoing.destroy(error instanceof Error ? error : new Error(String(error))),
            );
        },
      });
      const headers = Object.fromEntries(request.headers);
      delete headers["transfer-encoding"];
      const response = await client.request({
        path: `${url.pathname}${url.search}`,
        method: request.method as Undici.Dispatcher.HttpMethod,
        headers,
        ...(request.body
          ? {
              body: NodeStream.Readable.fromWeb(
                request.body as NodeStreamWeb.ReadableStream<Uint8Array>,
              ),
            }
          : {}),
        signal: request.signal,
      });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value])
          responseHeaders.append(name, part);
      const hasBody = request.method !== "HEAD" && ![204, 205, 304].includes(response.statusCode);
      if (!hasBody) response.body.resume();
      return new Response(
        hasBody ? (NodeStream.Readable.toWeb(response.body) as ReadableStream<Uint8Array>) : null,
        { status: response.statusCode, headers: responseHeaders },
      );
    },
    async dispose() {
      lifetime.abort();
      await client?.destroy();
      await connecting?.catch(() => undefined);
      await lifetime.join();
    },
  };
}
