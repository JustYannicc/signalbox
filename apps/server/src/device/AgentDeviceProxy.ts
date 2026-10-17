import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
  HttpRouter,
} from "effect/http";

import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import { observeAgentDeviceCommandResponse } from "./AgentDeviceCommandObservation.ts";
import * as DeviceService from "./DeviceService.ts";
import { findAgentDeviceSession, listAgentDeviceSessions } from "./AgentDeviceSession.ts";
import { AGENT_DEVICE_PROXY_ROUTE_PREFIX } from "./AgentDeviceProxyProtocol.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import {
  agentDeviceCommandName,
  agentDeviceRpcSessionId,
  decodeAgentDeviceRpcRequestText,
} from "./AgentDeviceRpc.ts";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
]);

const routeMethod = (path: string) => {
  if (
    path === "rpc" ||
    path === "upload" ||
    path === "upload/preflight" ||
    path === "upload/finalize"
  ) {
    return "POST";
  }
  if (/^upload\/direct\/[^/]+$/.test(path)) return "PUT";
  if (
    path === "health" ||
    /^artifacts\/[^/]+$/.test(path) ||
    /^sessions\/[^/]+\/requests\/[^/]+\/diagnostics$/.test(path)
  ) {
    return "GET";
  }
  return null;
};

const permittedPath = (path: string, sessionId: string) => {
  if (
    path === "rpc" ||
    path === "health" ||
    path === "upload" ||
    /^artifacts\/[^/]+$/.test(path) ||
    path === "upload/preflight" ||
    path === "upload/finalize" ||
    /^upload\/direct\/[^/]+$/.test(path)
  ) {
    return true;
  }
  const diagnostics = /^sessions\/([^/]+)\/requests\/[^/]+\/diagnostics$/.exec(path);
  return diagnostics?.[1] === encodeURIComponent(sessionId);
};

const authorized = (request: HttpServerRequest.HttpServerRequest, token: string) => {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const tokenHeader = request.headers["x-agent-device-token"];
  return bearer === token && tokenHeader === token;
};

const upstreamUrl = (baseUrl: string, route: string, search: string) => {
  try {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const url = new URL(route, base);
    if (url.pathname !== `${base.pathname}${route}`) return null;
    url.search = search;
    return url.toString();
  } catch {
    return null;
  }
};

const forwardedHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      name === "host" ||
      name === "content-length" ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
};

const responseHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  return forwarded;
};

const pathInfo = (request: HttpServerRequest.HttpServerRequest) => {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return null;
  const suffix = url.value.pathname.slice(AGENT_DEVICE_PROXY_ROUTE_PREFIX.length + 1);
  const [encodedSessionId, ...routeParts] = suffix.split("/");
  if (!encodedSessionId || routeParts.length === 0) return null;
  try {
    return {
      sessionId: decodeURIComponent(encodedSessionId),
      route: routeParts.join("/"),
      search: url.value.search,
    };
  } catch {
    return null;
  }
};

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const info = pathInfo(request);
  if (!info || !permittedPath(info.route, info.sessionId)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const expectedMethod = routeMethod(info.route);
  if (!expectedMethod || request.method !== expectedMethod) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }

  const devices = yield* DeviceService.DeviceService;
  const diagnostics = yield* DeviceAgentDiagnostics.DeviceAgentDiagnostics;
  const proxyRegistry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
  const before = findAgentDeviceSession(yield* devices.state, info.sessionId);
  if (!before) return HttpServerResponse.text("Device session is not active", { status: 404 });

  const registered = yield* proxyRegistry.get(info.sessionId);
  if (!registered || registered.hostId !== before.hostId) {
    return HttpServerResponse.text("Device tools are not available", { status: 503 });
  }
  if (!authorized(request, registered.proxyToken)) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }

  let rpcBody: string | null = null;
  let command: string | null = null;
  if (info.route === "rpc") {
    const bodyText = yield* request.text.pipe(Effect.catch(() => Effect.succeed(null)));
    if (bodyText === null)
      return HttpServerResponse.text("Invalid agent-device request", { status: 400 });
    const body = decodeAgentDeviceRpcRequestText(bodyText);
    if (!body) return HttpServerResponse.text("Invalid agent-device request", { status: 400 });
    if (agentDeviceRpcSessionId(body.params) !== info.sessionId) {
      return HttpServerResponse.text("Device session does not match the request", { status: 409 });
    }
    rpcBody = bodyText;
    if (body.method === "agent_device.command") command = agentDeviceCommandName(body.params);
  }

  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const target = upstreamUrl(registered.endpoint.baseUrl, info.route, info.search);
  if (target === null) {
    return HttpServerResponse.text("Invalid agent-device route", { status: 400 });
  }
  const upstreamRequest = HttpClientRequest.make(request.method)(target).pipe(
    HttpClientRequest.setHeaders({
      ...forwardedHeaders(request),
      authorization: `Bearer ${registered.endpoint.token}`,
      "x-agent-device-token": registered.endpoint.token,
    }),
  );
  const requestWithBody =
    rpcBody !== null
      ? HttpClientRequest.bodyText(upstreamRequest, rpcBody, request.headers["content-type"])
      : request.method === "GET"
        ? upstreamRequest
        : HttpClientRequest.bodyStream(upstreamRequest, request.stream);
  const response = yield* httpClient.execute(requestWithBody);

  const responseStream =
    command === null
      ? response.stream
      : observeAgentDeviceCommandResponse(response, {
          command,
          session: before,
          proxyToken: registered.proxyToken,
          daemonToken: registered.endpoint.token,
          devices,
          diagnostics,
        });

  return HttpServerResponse.stream(responseStream, {
    status: response.status,
    headers: responseHeaders(response.headers),
  });
});

export const routeLayer = HttpRouter.add("*", `${AGENT_DEVICE_PROXY_ROUTE_PREFIX}/*`, handler);

const pruneRegistry = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  yield* DeviceService.stateStream(devices).pipe(
    Stream.runForEach((state) =>
      registry
        .retainSessions(new Set(listAgentDeviceSessions(state).map((session) => session.sessionId)))
        .pipe(
          Effect.flatMap((configPaths) =>
            Effect.forEach(configPaths, (configPath) => fs.remove(configPath, { force: true }), {
              discard: true,
            }),
          ),
          Effect.ignore,
        ),
    ),
    Effect.forkIn(scope),
    Effect.asVoid,
  );
});

export const layer = Layer.mergeAll(routeLayer, Layer.effectDiscard(pruneRegistry));
