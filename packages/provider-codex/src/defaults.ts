import { CodexSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MCP_APP_EXTENSION_ID, MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";

export const CODEX_PROVIDER = ProviderDriverKind.make("codex");

export const CODEX_DRIVER_KIND = CODEX_PROVIDER;

export const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER_KIND);

export const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

export const CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50;

// Each plan flush stores the whole plan three times (node, plan, turn item), so
// flush at the cadence clients already see for assistant text.
export const CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS = 400;

export const CodexBackgroundTerminalTerminateResponse = Schema.Struct({
  terminated: Schema.Boolean,
});

export const CodexBackgroundTerminalsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      processId: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});

export type CodexBackgroundTerminalsListPage = typeof CodexBackgroundTerminalsListResponse.Type;

export const decodeCodexBackgroundTerminalTerminateResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalTerminateResponse,
);

export const decodeCodexBackgroundTerminalsListResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalsListResponse,
);

export const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: ["turn/diff/updated"],
  extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
} as const;

export const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;
