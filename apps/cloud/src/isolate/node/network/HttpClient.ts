// @effect-diagnostics nodeBuiltinImport:off - Non-loopback requests delegate to the host Node HTTP implementation.
import * as NodeHttp from "node:http";
import { LoopbackRegistry } from "./LoopbackRegistry.ts";
import { authorityHost, isLocalHost, parsePort } from "./address.ts";
import { networkError } from "./errors.ts";
import { hasTlsHandshakeOptions } from "./tlsOptions.ts";
import { LocalClientRequest } from "./LocalClientRequest.ts";
import type { HttpServerHandlerFactory, ParsedRequest } from "./HttpClientTypes.ts";

function looksLikeUrl(value: unknown): value is string | URL {
  return typeof value === "string" || value instanceof URL;
}

function requestParts(args: readonly unknown[], protocol: "http" | "https") {
  const input = args[0];
  const second = args[1];
  const third = args[2];
  let options: Record<string, unknown> = {};
  let callback: ParsedRequest["callback"];
  let url: URL | undefined;
  if (looksLikeUrl(input)) {
    url = new URL(String(input));
    if (typeof second === "function") callback = second as ParsedRequest["callback"];
    else if (typeof second === "object" && second !== null)
      options = { ...(second as Record<string, unknown>) };
    if (typeof third === "function") callback = third as ParsedRequest["callback"];
    if (url.username || url.password) {
      options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    }
  } else {
    if (typeof input === "object" && input !== null)
      options = { ...(input as Record<string, unknown>) };
    if (typeof second === "function") callback = second as ParsedRequest["callback"];
    else if (typeof second === "object" && second !== null)
      options = { ...options, ...(second as Record<string, unknown>) };
    if (typeof third === "function") callback = third as ParsedRequest["callback"];
  }

  const requestProtocol =
    typeof options.protocol === "string" ? options.protocol : (url?.protocol ?? `${protocol}:`);
  const rawHost = options.hostname ?? options.host ?? url?.hostname ?? "localhost";
  let host = String(rawHost).replace(/^\[|\]$/g, "");
  let rawPort = options.port ?? url?.port;
  if (rawPort === undefined && typeof options.host === "string") {
    const hostPort =
      /^\[([^\]]+)\]:(\d+)$/.exec(options.host) ?? /^([^:]+):(\d+)$/.exec(options.host);
    if (hostPort) {
      host = hostPort[1]!;
      rawPort = hostPort[2];
    }
  }
  const defaultPort = protocol === "https" ? 443 : 80;
  const port = parsePort(rawPort, defaultPort);
  const path =
    typeof options.path === "string"
      ? options.path
      : `${url?.pathname ?? "/"}${url?.search ?? ""}` || "/";
  const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
  return { options, callback, requestProtocol, host, port, path, method };
}

function parsedRequest(
  args: readonly unknown[],
  protocol: "http" | "https",
): ParsedRequest | undefined {
  let parts: ReturnType<typeof requestParts>;
  try {
    parts = requestParts(args, protocol);
  } catch {
    return undefined;
  }
  if (!isLocalHost(parts.host)) return undefined;
  if (parts.requestProtocol !== `${protocol}:`) {
    throw networkError(
      "ERR_INVALID_PROTOCOL",
      `Protocol "${parts.requestProtocol}" not supported. Expected "${protocol}:"`,
    );
  }
  if (!parts.path.startsWith("/") && parts.path !== "*") {
    throw networkError("ERR_INVALID_ARG_VALUE", "options.path must be a path-only request target");
  }
  const target = new URL(
    `${protocol}://${authorityHost(parts.host)}:${parts.port}${parts.path === "*" ? "/" : parts.path}`,
  );
  return { ...parts, protocol, url: target };
}

function makeLocalRequest(
  args: readonly unknown[],
  protocol: "http" | "https",
  registry: LoopbackRegistry,
  handlerFor: HttpServerHandlerFactory,
  env: unknown,
  ctx: unknown,
  fallbackAgent: unknown,
): LocalClientRequest | undefined {
  const parsed = parsedRequest(args, protocol);
  if (!parsed) return undefined;
  if (protocol === "https" && hasTlsHandshakeOptions(parsed.options)) {
    throw networkError(
      "ENOTSUP",
      "TLS client options are not used by logical loopback HTTPS dispatch",
    );
  }
  if (
    parsed.options.socketPath !== undefined ||
    parsed.options.createConnection !== undefined ||
    parsed.options.lookup !== undefined
  ) {
    throw networkError(
      "ERR_OPTION_NOT_IMPLEMENTED",
      "Local HTTP requests do not support socketPath, createConnection, or lookup",
    );
  }
  const binding = registry.getForProtocol(parsed.port, protocol);
  return new LocalClientRequest({ parsed, binding, registry, handlerFor, env, ctx }, fallbackAgent);
}

export function createHttpClientExports(
  protocol: "http" | "https",
  registry: LoopbackRegistry,
  handlerFor: HttpServerHandlerFactory,
  env: unknown,
  ctx: unknown,
  native: object,
): {
  readonly request: (...args: unknown[]) => NodeHttp.ClientRequest | LocalClientRequest;
  readonly get: (...args: unknown[]) => NodeHttp.ClientRequest | LocalClientRequest;
} {
  const nativeRequest = Reflect.get(native, "request");
  if (typeof nativeRequest !== "function")
    throw new TypeError("Native HTTP request is unavailable");
  const fallbackAgent = Reflect.get(native, "globalAgent");
  const request = (...args: unknown[]): NodeHttp.ClientRequest | LocalClientRequest =>
    makeLocalRequest(args, protocol, registry, handlerFor, env, ctx, fallbackAgent) ??
    (Reflect.apply(nativeRequest, native, args) as NodeHttp.ClientRequest);
  const get = (...args: unknown[]): NodeHttp.ClientRequest | LocalClientRequest => {
    const req = request(...args);
    req.end();
    return req;
  };
  return Object.freeze({
    request,
    get,
  });
}
