import type {
  ClientMessage,
  CodeModeExecuteRequest,
  CodeModeToolDefinition,
  HostRequest,
  Json,
} from "./types.ts";

type ObjectValue = { [key: string]: Json };
const invalid = (): never => {
  throw new Error("Invalid CodeMode V1 message");
};
function object(value: Json | undefined): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value;
}
function keys(value: ObjectValue, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function string(value: Json | undefined): string {
  return typeof value === "string" ? value : invalid();
}
function identifier(value: Json | undefined): string {
  const result = string(value);
  return result.trim() ? result : invalid();
}
function number(value: Json | undefined, minimum = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : invalid();
}
function list<T>(value: Json | undefined, parse: (value: Json) => T): T[] {
  return Array.isArray(value) ? value.map(parse) : invalid();
}
function optionalNumber(value: Json | undefined, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === undefined || value === null) return null;
  const result = number(value);
  return result <= maximum ? result : invalid();
}

function tool(value: Json): CodeModeToolDefinition {
  const source = object(value);
  keys(source, ["name", "tool_name", "description", "kind", "input_schema", "output_schema"]);
  const name = object(source.tool_name);
  keys(name, ["name", "namespace"]);
  const kind = source.kind;
  if (kind !== "function" && kind !== "freeform") return invalid();
  return {
    name: string(source.name),
    tool_name: {
      name: string(name.name),
      namespace: name.namespace == null ? null : string(name.namespace),
    },
    description: string(source.description),
    kind,
    input_schema: source.input_schema ?? null,
    output_schema: source.output_schema ?? null,
  };
}

function execute(value: Json | undefined): CodeModeExecuteRequest {
  const source = object(value);
  keys(source, ["tool_call_id", "source", "enabled_tools", "yield_time_ms", "max_output_tokens"]);
  return {
    tool_call_id: string(source.tool_call_id),
    source: string(source.source),
    enabled_tools: list(source.enabled_tools, tool),
    yield_time_ms: optionalNumber(source.yield_time_ms),
    max_output_tokens: optionalNumber(source.max_output_tokens, 2_147_483_647),
  };
}

function request(value: Json | undefined): HostRequest {
  const source = object(value);
  const sessionId = identifier(source.sessionId);
  switch (source.method) {
    case "session/open": {
      keys(source, ["method", "sessionId", "cellExecutionLimits"]);
      if (source.cellExecutionLimits == null) return { method: source.method, sessionId };
      const limits = object(source.cellExecutionLimits);
      keys(limits, ["maxYieldTimeMs", "maxHeapSizeBytes"]);
      const maxYieldTimeMs = optionalNumber(limits.maxYieldTimeMs);
      const maxHeapSizeBytes = optionalNumber(limits.maxHeapSizeBytes);
      return {
        method: source.method,
        sessionId,
        cellExecutionLimits: {
          ...(maxYieldTimeMs === null ? {} : { maxYieldTimeMs }),
          ...(maxHeapSizeBytes === null ? {} : { maxHeapSizeBytes }),
        },
      };
    }
    case "session/execute":
      keys(source, ["method", "sessionId", "request"]);
      return { method: source.method, sessionId, request: execute(source.request) };
    case "session/wait": {
      keys(source, ["method", "sessionId", "request"]);
      const wait = object(source.request);
      keys(wait, ["cell_id", "yield_time_ms"]);
      return {
        method: source.method,
        sessionId,
        request: { cell_id: string(wait.cell_id), yield_time_ms: number(wait.yield_time_ms) },
      };
    }
    case "session/terminate":
      keys(source, ["method", "sessionId", "cellId"]);
      return { method: source.method, sessionId, cellId: string(source.cellId) };
    case "session/shutdown":
      keys(source, ["method", "sessionId"]);
      return { method: source.method, sessionId };
    default:
      return invalid();
  }
}

export function parseCodeModeMessage(value: Json): ClientMessage {
  const source = object(value);
  switch (source.type) {
    case "connection/hello": {
      keys(source, ["type", "supportedVersions", "requiredCapabilities", "optionalCapabilities"]);
      const supportedVersions = list(source.supportedVersions, (v) => number(v, 1));
      const requiredCapabilities = list(source.requiredCapabilities, identifier);
      const optionalCapabilities = list(source.optionalCapabilities, identifier);
      if (
        supportedVersions.length === 0 ||
        new Set(supportedVersions).size !== supportedVersions.length ||
        new Set([...requiredCapabilities, ...optionalCapabilities]).size !==
          requiredCapabilities.length + optionalCapabilities.length
      )
        invalid();
      return { type: source.type, supportedVersions, requiredCapabilities, optionalCapabilities };
    }
    case "operation/request":
      keys(source, ["type", "id", "request"]);
      return {
        type: source.type,
        id: number(source.id, Number.MIN_SAFE_INTEGER),
        request: request(source.request),
      };
    case "operation/cancel":
    case "operation/yield":
      keys(source, ["type", "id"]);
      return { type: source.type, id: number(source.id, Number.MIN_SAFE_INTEGER) };
    case "delegate/response": {
      keys(source, ["type", "id", "result"]);
      const id = number(source.id, Number.MIN_SAFE_INTEGER);
      const result = object(source.result);
      if (result.status === "error") {
        keys(result, ["status", "message"]);
        return {
          type: source.type,
          id,
          result: { status: "error", message: string(result.message) },
        };
      }
      keys(result, ["status", "value"]);
      if (result.status !== "ok") return invalid();
      const response = object(result.value);
      if (response.type === "tool/result") {
        keys(response, ["type", "result"]);
        if (response.result === undefined) return invalid();
        return {
          type: source.type,
          id,
          result: { status: "ok", value: { type: response.type, result: response.result } },
        };
      }
      keys(response, ["type"]);
      if (response.type !== "notification/delivered") return invalid();
      return { type: source.type, id, result: { status: "ok", value: { type: response.type } } };
    }
    default:
      return invalid();
  }
}
