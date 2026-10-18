import * as Schema from "effect/Schema";
import type { ProviderUserInputAnswers } from "@t3tools/contracts";
import {
  nativeElicitationForm,
  nativeElicitationResponse,
} from "@t3tools/shared/nativeElicitation";
import type * as CodexSchema from "effect-codex-app-server/schema";

export function codexMcpElicitationForm(payload: CodexSchema.McpServerElicitationRequestParams) {
  return payload.mode === "url"
    ? null
    : nativeElicitationForm(payload.requestedSchema, payload.message);
}

export function codexMcpElicitationResponse(
  payload: CodexSchema.McpServerElicitationRequestParams,
  answers: ProviderUserInputAnswers,
): CodexSchema.McpServerElicitationRequestResponse {
  if (payload.mode === "url") return { action: "decline" };
  return nativeElicitationResponse(codexMcpElicitationForm(payload), answers);
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

// Codex approvals carry refusal and persistence semantics that a data form cannot represent.
export function isCodexMcpApproval(payload: CodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url") return false;
  const meta = isRecord(payload._meta) ? payload._meta : undefined;
  const requested = isRecord(payload.requestedSchema) ? payload.requestedSchema : undefined;
  const properties = isRecord(requested?.properties) ? requested.properties : undefined;
  return (
    meta?.codex_approval_kind === "mcp_tool_call" ||
    meta?.allowPersistentApproval === true ||
    (meta?.persist !== undefined && meta.persist !== null) ||
    /^Allow ChatGPT to use .+\?$/i.test(payload.message) ||
    (requested?.type === "object" &&
      (requested.properties === undefined ||
        (properties !== undefined && Object.keys(properties).length === 0)))
  );
}
