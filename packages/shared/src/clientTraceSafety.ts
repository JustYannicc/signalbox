import { WsRpcGroup } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

export const CLIENT_TRACES_PATH = "/api/observability/v1/traces";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKOS_ORG = /^org_[0-9A-HJKMNP-TV-Z]{26}$/;

const OPERATIONS = new Set([
  "EnvironmentRpc.request",
  "EnvironmentRpc.authorize",
  "EnvironmentRpc.currentSession",
  "EnvironmentRpc.getInitialServerConfig",
  "EnvironmentRpc.runStream",
  "EnvironmentRpc.subscribe",
  "environment.websocket.connect",
  "environment.initialSync",
  "clientRuntime.connection.rpcSession.probe",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "http.client",
  "client.operation",
]);

/** Only code-owned operation names and RPC tags are telemetry, never interpolated names. */
export const clientSpanName = (name: string) =>
  OPERATIONS.has(name) || WsRpcGroup.requests.has(name) ? name : "client.operation";

export function clientSpanAttribute(key: string, value: unknown): boolean {
  if (key === "rpc.method") return typeof value === "string" && WsRpcGroup.requests.has(value);
  if (key === "http.request.method") {
    return (
      typeof value === "string" &&
      ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(value)
    );
  }
  if (key === "http.response.status_code")
    return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
  if (key === "error") return typeof value === "boolean";
  if (key === "org.id") return typeof value === "string" && WORKOS_ORG.test(value);
  if (["thread.id", "folder.id", "automation.id", "environment.id"].includes(key)) {
    return typeof value === "string" && UUID.test(value);
  }
  return false;
}

/** Drop content before the exporter sees it, including failure causes, events and link attributes. */
export function contentFreeTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span({
        ...options,
        name: clientSpanName(options.name),
        links: [],
      });
      const attribute = span.attribute.bind(span);
      const end = span.end.bind(span);
      span.attribute = (key, value) => {
        if (clientSpanAttribute(key, value)) attribute(key, value);
      };
      span.event = () => {};
      span.addLinks = () => {};
      span.end = (time, exit) =>
        end(time, Exit.isSuccess(exit) ? Exit.void : Exit.fail("Client operation failed"));
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

/** Only thread identity crosses into telemetry; payload fields and strings never do. */
export function clientThreadAttributes(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) return {};
  const source =
    "command" in input && typeof input.command === "object" && input.command !== null
      ? input.command
      : input;
  return "threadId" in source && typeof source.threadId === "string" && UUID.test(source.threadId)
    ? { "thread.id": source.threadId }
    : {};
}
