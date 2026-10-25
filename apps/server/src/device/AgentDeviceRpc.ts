import { type DeviceAgentCommandFailureInput } from "./DeviceAgentDiagnostics.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
export const AgentDeviceRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Unknown),
  method: Schema.String,
  params: JsonRecord,
});
export type AgentDeviceRpcRequest = typeof AgentDeviceRpcRequestSchema.Type;
const RpcErrorData = Schema.Struct({
  message: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  diagnosticId: Schema.optional(Schema.String),
  logPath: Schema.optional(Schema.String),
  details: Schema.optional(JsonRecord),
});
const RpcError = Schema.Struct({
  message: Schema.optional(Schema.String),
  data: Schema.optional(RpcErrorData),
});

const decodeRpcRequest = Schema.decodeUnknownOption(AgentDeviceRpcRequestSchema);
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRecord));
const decodeObjectRecord = Schema.decodeUnknownOption(JsonRecord);
const decodeRpcError = Schema.decodeUnknownOption(RpcError);
const decodeString = Schema.decodeUnknownOption(Schema.String);

const MAX_TEXT_LENGTH = 2048;
const SIMULATOR_SERVICE_HUB_UNAVAILABLE = "simulator_service_hub_unavailable";

const SELECT_NEWER_XCODE_HINT =
  "Select an Xcode version that supports this macOS on the device host. Use xcode-select -s, or set DEVELOPER_DIR for the agent-device daemon.";

const safeText = (value: string | undefined, tokens: ReadonlyArray<string>) => {
  if (value === undefined) return undefined;
  const redacted = tokens.reduce(
    (text, token) => (token.length === 0 ? text : text.replaceAll(token, "[redacted]")),
    value,
  );
  return redacted.slice(0, MAX_TEXT_LENGTH);
};

export const decodeAgentDeviceRpcRequest = (value: unknown) =>
  Option.getOrNull(decodeRpcRequest(value));

export const decodeAgentDeviceRpcRequestText = (text: string) => {
  try {
    return decodeAgentDeviceRpcRequest(JSON.parse(text));
  } catch {
    return null;
  }
};

export const agentDeviceRpcSessionId = (params: Readonly<Record<string, unknown>>) =>
  Option.getOrNull(decodeString(params.session));

export const agentDeviceCommandName = (params: Readonly<Record<string, unknown>>) => {
  const command = Option.getOrNull(decodeString(params.command));
  return command?.slice(0, 64) ?? "unknown";
};

export type AgentDeviceCommandOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly failure: DeviceAgentCommandFailureInput }
  | null;

const responseRecord = (text: string, ndjson: boolean) => {
  const lines = ndjson ? text.split(/\r?\n/) : [text];
  for (const line of lines) {
    if (line.length === 0) continue;
    const record = Option.getOrNull(decodeJsonRecord(line));
    if (!record) continue;
    if (record.type === "progress") continue;
    if (record.type === "response") {
      const response = Option.getOrNull(decodeObjectRecord(record.response));
      if (response) return response;
      continue;
    }
    return record;
  }
  return null;
};

export const agentDeviceCommandOutcome = (input: {
  readonly body: string;
  readonly contentType: string | undefined;
  readonly status: number;
  readonly command: string;
  readonly tokens: ReadonlyArray<string>;
}): AgentDeviceCommandOutcome => {
  const response = responseRecord(
    input.body,
    input.contentType?.toLowerCase().includes("application/x-ndjson") ?? false,
  );
  const hasError = response !== null && Object.hasOwn(response, "error");
  if (input.status < 200 || input.status >= 300) {
    if (!hasError) {
      return {
        kind: "failure",
        failure: {
          command: input.command,
          message: `Agent-device command failed (HTTP ${input.status}).`,
        },
      };
    }
  }
  if (!response) {
    return {
      kind: "failure",
      failure: {
        command: input.command,
        message: "Agent-device returned an invalid command response.",
      },
    };
  }

  if (hasError) {
    const error = Option.getOrNull(decodeRpcError(response.error));
    const data = error?.data;
    const reason = data?.details
      ? (Option.getOrNull(decodeString(data.details.reason)) ?? undefined)
      : undefined;
    const message = safeText(data?.message ?? error?.message, input.tokens);
    const hint =
      safeText(data?.hint, input.tokens) ||
      (reason === SIMULATOR_SERVICE_HUB_UNAVAILABLE ? SELECT_NEWER_XCODE_HINT : undefined);
    const diagnosticId = safeText(data?.diagnosticId, input.tokens);
    const logPath = safeText(data?.logPath, input.tokens);
    return {
      kind: "failure",
      failure: {
        command: safeText(input.command, input.tokens)?.slice(0, 64) ?? "unknown",
        message: message || "Agent-device command failed.",
        ...(reason !== undefined ? { reason: safeText(reason, input.tokens)?.slice(0, 128) } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(diagnosticId !== undefined ? { diagnosticId } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
      },
    };
  }

  if (Object.hasOwn(response, "result")) return { kind: "success" };
  return {
    kind: "failure",
    failure: {
      command: input.command,
      message: "Agent-device returned an invalid command response.",
    },
  };
};

export const agentDeviceCommandOutcomeFromNdjsonRecord = (input: {
  readonly body: string;
  readonly status: number;
  readonly command: string;
  readonly tokens: ReadonlyArray<string>;
}): AgentDeviceCommandOutcome => {
  const record = Option.getOrNull(decodeJsonRecord(input.body));
  if (!record || record.type === "progress") return null;
  const response =
    record.type === "response" ? Option.getOrNull(decodeObjectRecord(record.response)) : record;
  if (!response) return null;
  return agentDeviceCommandOutcome({
    ...input,
    body: JSON.stringify(response),
    contentType: "application/json",
  });
};
