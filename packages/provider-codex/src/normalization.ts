import { mcpToolPresentation, type McpToolPresentation } from "./toolPresentation.ts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import {
  COMPUTER_USE_TOOL_SOURCE,
  dynamicToolSurface,
  dynamicToolTitle,
} from "@t3tools/shared/toolActivity";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import type {
  OrchestrationV2ExecutionNode,
  ModelSelection,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderRequestKind,
} from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CODEX_PROVIDER } from "./defaults.ts";
import { type CodexWebSearchItem, type CodexDynamicToolItem } from "./nativeItems.ts";

export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
  readonly fileChanges?: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"];
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map(([path, change]) => {
      const movePath = change.type === "update" ? change.move_path : undefined;
      return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}

// Reasoning effort changes future generation, not the existing context's tokenizer
// or model window. All other option changes remain untrusted until new telemetry.
export function canReuseCodexContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  return modelSelectionsEqual(
    {
      ...previous,
      options: (previous.options ?? []).filter((option) => option.id !== "reasoningEffort"),
    },
    { ...next, options: (next.options ?? []).filter((option) => option.id !== "reasoningEffort") },
  );
}

export function codexProviderTurnTokenUsage(
  tokenUsage: CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  updatedAt: string,
) {
  return {
    usedTokens: Math.max(0, tokenUsage.last.totalTokens),
    maxTokens: tokenUsage.modelContextWindow ?? null,
    inputTokens: Math.max(0, tokenUsage.last.inputTokens),
    cachedInputTokens: Math.max(0, tokenUsage.last.cachedInputTokens),
    outputTokens: Math.max(0, tokenUsage.last.outputTokens),
    reasoningOutputTokens: Math.max(0, tokenUsage.last.reasoningOutputTokens),
    updatedAt,
  };
}

export function toProtocolError(
  detail: string,
  payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

export function normalizeCodexCause(error: unknown): unknown {
  return error;
}

export function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.makeUnsafe(seconds * 1000);
}

export function codexUserMessageText(
  content: ReadonlyArray<CodexSchema.V2ItemCompletedNotification__UserInput>,
): string {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
}

export function mapCodexTurnStatus(
  status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "inProgress":
      return "running";
  }
}

export function providerTurnStatusToTerminal(
  status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "running":
      return "failed";
  }
}

export function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

/**
 * The composers let a skill be typed with any currency sigil (`€review`), but
 * Codex only parses `$name` as a skill mention.
 */
export function codexSkillMentionText(text: string): string {
  return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}

export const BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH = 200;

export const BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH = 1_000;

export function codexBackgroundCommandDetail(item: {
  readonly command: string;
  readonly exitCode?: number | null | undefined;
  readonly aggregatedOutput?: string | null | undefined;
}): string {
  const command =
    item.command.length > BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH
      ? `${item.command.slice(0, BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH)}...`
      : item.command;
  const exit =
    item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
  const output = (item.aggregatedOutput ?? "").trimEnd();
  const outputTail =
    output.length > BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH
      ? `...${output.slice(-BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH)}`
      : output;
  const header = `Background command completed${exit}: ${command}`;
  return outputTail.length === 0 ? header : `${header}\n\nOutput tail:\n${outputTail}`;
}

export interface CodexDynamicToolProjection extends McpToolPresentation {
  readonly toolName: string;
  readonly title?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: OrchestrationV2TurnItem["status"];
}

export function codexMcpToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : item.result.structuredContent !== null && item.result.structuredContent !== undefined
        ? item.result.structuredContent
        : item.result.content;

  if (item.error === null || item.error === undefined) {
    return resultOutput;
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

// Reading an app's resource is one MCP round trip; a server that hangs must not
// hold the item (and the run's ingestion) open.
export const MCP_APP_CAPTURE_TIMEOUT = "20 seconds";

export function codexMcpAppResourceUri(item: CodexDynamicToolItem): string | undefined {
  if (item.type !== "mcpToolCall") return undefined;
  const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

export function codexDynamicToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems;
  }
  return item.success === false ? { success: false } : undefined;
}

export const projectCodexDynamicToolItem = Effect.fn("CodexAdapterV2.projectDynamicToolItem")(
  function* (
    item: CodexDynamicToolItem,
  ): Effect.fn.Return<CodexDynamicToolProjection, never, Crypto.Crypto> {
    const output =
      item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
    const toolName =
      item.type === "mcpToolCall"
        ? `${item.server}.${item.tool}`
        : [trimText(item.namespace), item.tool].filter(Boolean).join(".");
    const presentation: McpToolPresentation =
      item.type === "mcpToolCall" ? yield* mcpToolPresentation(item) : {};
    const title =
      dynamicToolTitle(toolName, item.arguments, presentation.title) ?? presentation.title;
    const toolSurface = presentation.toolSurface ?? dynamicToolSurface(toolName, item.arguments);
    const toolSource =
      toolSurface === "computer" && presentation.toolSource?.kind !== "computer"
        ? COMPUTER_USE_TOOL_SOURCE
        : presentation.toolSource;
    const projection: CodexDynamicToolProjection = {
      ...presentation,
      ...(toolSurface ? { toolSurface } : {}),
      ...(toolSource ? { toolSource } : {}),
      toolName,
      ...(title ? { title } : {}),
      input: item.arguments,
      status: codexItemStatus(item.status).turnItem,
    };
    return output === undefined ? projection : { ...projection, output };
  },
);

export function codexNativeItemRef(nativeItemId: string) {
  return {
    driver: CODEX_PROVIDER,
    nativeId: nativeItemId,
    strength: "strong" as const,
  };
}

export function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function nonEmptyText(value: string | null | undefined, fallback: string): string {
  return trimText(value) ?? fallback;
}

export function codexPlanStepStatus(
  status: CodexSchema.V2TurnPlanUpdatedNotification__TurnPlanStepStatus,
): OrchestrationV2PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "running";
    case "pending":
      return "pending";
  }
}

export function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
    case "acceptAlways":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

export function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  if ((permissions.fileSystem?.write?.length ?? 0) > 0) {
    return "file-change";
  }
  if ((permissions.fileSystem?.read?.length ?? 0) > 0) {
    return "file-read";
  }
  return "command";
}

export function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

export function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
  allowedQuestionIds: ReadonlySet<string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) =>
      allowedQuestionIds.has(questionId)
        ? [[questionId, { answers: [...answerValueToStrings(value)] }]]
        : [],
    ),
  );
}

export function compactStrings(
  values: ReadonlyArray<string | null | undefined>,
): ReadonlyArray<string> {
  return values.flatMap((value) => {
    const trimmed = trimText(value);
    return trimmed === undefined ? [] : [trimmed];
  });
}

export function webSearchPatterns(item: CodexWebSearchItem): ReadonlyArray<string> {
  if (item.action === null || item.action === undefined) {
    return compactStrings([item.query]);
  }

  switch (item.action.type) {
    case "search":
      return compactStrings([...(item.action.queries ?? []), item.action.query, item.query]);
    case "openPage":
      return compactStrings([item.action.url, item.query]);
    case "findInPage":
      return compactStrings([item.action.pattern, item.action.url, item.query]);
    case "other":
      return compactStrings([item.query]);
  }
}

export function parseCodexRetryProgress(
  message: string,
): Pick<OrchestrationV2ProviderRetry, "attempt" | "maxAttempts"> | null {
  const match = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (attempt < 1 || maxAttempts < 1) {
    return null;
  }
  return { attempt, maxAttempts };
}

export function codexErrorInfoCode(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return Object.keys(value)[0] ?? null;
}
