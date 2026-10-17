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
