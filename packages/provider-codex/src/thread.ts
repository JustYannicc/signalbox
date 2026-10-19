import { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type {
  ModelSelection,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderTurnId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { getCodexServiceTierOptionValue } from "./modelOptions.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./developerInstructions.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CODEX_PROVIDER, CodexProviderCapabilitiesV2 } from "./defaults.ts";
import { toProtocolError, codexTimestamp } from "./normalization.ts";

export const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);

export const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);

export const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

export const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
  }),
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

export const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);

export function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
  }
}

export function buildCodexTurnStartParams(input: {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly hasT3Mcp?: boolean;
  readonly browserToolsAvailable?: boolean;
  readonly deviceToolsAvailable?: boolean;
  /** ChatGPT token sharing does not accept service tiers. */
  readonly omitServiceTier?: boolean;
  readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
}) {
  return Effect.gen(function* () {
    const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? runtimeModeDefaults.approvalPolicy
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? runtimeModeDefaults.sandboxPolicy
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const selectedEffort = getModelSelectionStringOptionValue(
      input.modelSelection,
      "reasoningEffort",
    );
    const effort =
      selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
    const serviceTier =
      input.omitServiceTier === true
        ? undefined
        : getCodexServiceTierOptionValue(input.modelSelection);
    const developerInstructions =
      input.hasT3Mcp !== true
        ? undefined
        : buildCodexDeveloperInstructions(input.runtimePolicy.interactionMode);
    // An app's context is text an MCP server wrote, so it goes in as untrusted
    // context: Codex renders it as quoted user-side input, never as developer
    // instructions.
    const appContext = Object.fromEntries(
      (input.appContext ?? []).map((entry) => [
        entry.key,
        { kind: "untrusted" as const, value: entry.text },
      ]),
    );
    const t3Context =
      input.hasT3Mcp === true
        ? buildCodexAdditionalContext(
            { model: input.modelSelection.model, reasoningEffort: effort ?? "medium" },
            {
              browser: input.browserToolsAvailable ?? true,
              device: input.deviceToolsAvailable ?? false,
            },
          )
        : undefined;
    const additionalContext =
      t3Context === undefined && Object.keys(appContext).length === 0
        ? undefined
        : { ...t3Context, ...appContext };
    const collaborationMode: CodexSchema.ClientRequest__CollaborationMode | undefined =
      input.runtimePolicy.interactionMode !== "plan" && developerInstructions === undefined
        ? undefined
        : {
            mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "default",
            settings: {
              model: input.modelSelection.model,
              reasoning_effort: effort ?? "medium",
              ...(developerInstructions === undefined
                ? {}
                : { developer_instructions: developerInstructions }),
            },
          };

    return yield* decodeCodexTurnStartParamsWithCollaborationMode({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(additionalContext ? { additionalContext } : {}),
      cwd: input.runtimePolicy.cwd,
      model: input.modelSelection.model,
      // Model catalogues can default summaries to "none". Request them on every
      // turn, including resumed threads, for T3's reasoning timeline.
      summary: "detailed",
      // Always explicit: omitting this on resume leaves Codex's previous
      // reviewer sticky after switching away from Auto mode.
      approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    });
  });
}

export function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly defaultCwd: string;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? input.defaultCwd,
    model: input.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

export function getNativeThreadId(providerThread: OrchestrationV2ProviderThread) {
  return Effect.gen(function* () {
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* toProtocolError(
        `Provider thread ${providerThread.id} is missing a native Codex thread id.`,
      );
    }
    return nativeThreadId;
  });
}

export function providerThreadFromCodexThread(input: {
  readonly appThreadId: ThreadId | null;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly ownerNodeId: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly thread: {
    readonly createdAt: number;
    readonly forkedFromId?: string | null;
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      driver: CODEX_PROVIDER,
      nativeId: input.thread.id,
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: codexTimestamp(input.thread.createdAt),
    updatedAt: codexTimestamp(input.thread.updatedAt),
  };
}

// Counts toward native rollback. `/goal` control turns never reach Codex and
// carry no native ref, so they must not consume a native turn on revert.
export const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.nativeTurnRef !== null &&
  (turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed" ||
    turn.status === "cancelled");

export type CodexGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

export type CodexThreadGoal = CodexSchema.V2ThreadGoalUpdatedNotification["goal"];

export const CODEX_GOAL_STATUSES = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
} as const satisfies Record<CodexThreadGoal["status"], OrchestrationV2ProviderGoal["status"]>;

export function providerGoalFromCodex(goal: CodexThreadGoal): OrchestrationV2ProviderGoal | null {
  const objective = goal.objective.trim();
  if (objective.length === 0) return null;
  return {
    objective,
    status: CODEX_GOAL_STATUSES[goal.status],
    tokensUsed: Math.max(0, goal.tokensUsed),
    tokenBudget: goal.tokenBudget ?? null,
    timeUsedSeconds: Math.max(0, goal.timeUsedSeconds),
  };
}

export const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

export function describeCodexGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

// Codex starts the next goal turn milliseconds after the last one completes.
export const CODEX_GOAL_CONTINUATION_GRACE = "5 seconds";

export const providerTurnsForThread = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
  providerTurns.filter((turn) => turn.providerThreadId === providerThread.id);

export const countTerminalTurnsAfterBoundary = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerTurnId: ProviderTurnId,
): number | null => {
  const boundaryTurn = providerTurns.find((turn) => turn.id === providerTurnId);
  if (boundaryTurn === undefined) {
    return null;
  }

  return providerTurns.filter(
    (turn) => turn.ordinal > boundaryTurn.ordinal && isTerminalProviderTurn(turn),
  ).length;
};

export const resolveCodexForkRollbackTurnCount = Effect.fn(
  "CodexAdapterV2.resolveForkRollbackTurnCount",
)(function* (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return 0;
  }

  const rollbackTurnCount = countTerminalTurnsAfterBoundary(
    providerTurnsForThread(input.sourceProviderTurns, input.sourceProviderThread),
    input.providerTurnId,
  );
  if (rollbackTurnCount === null) {
    return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
      driver: CODEX_PROVIDER,
      providerThreadId: input.sourceProviderThread.id,
      cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
    });
  }

  return rollbackTurnCount;
});

/**
 * `lastTurnId` is inclusive on the Codex side, so a fork requested at the
 * selected turn omits every later turn atomically. That matters for paginated
 * threads.
 */
export const resolveCodexForkBoundary = Effect.fn("CodexAdapterV2.resolveForkBoundary")(function* (
  input: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
) {
  const rollbackTurnCount = yield* resolveCodexForkRollbackTurnCount(input);
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  const boundaryTurn = providerTurnsForThread(
    input.sourceProviderTurns,
    input.sourceProviderThread,
  ).find((turn) => turn.id === input.providerTurnId);
  const nativeTurnId = boundaryTurn?.nativeTurnRef?.nativeId;
  if (nativeTurnId === null || nativeTurnId === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  return { lastTurnId: nativeTurnId, rollbackTurnCount: 0 };
});

/**
 * The generated `thread/read` response schema does not surface `historyMode`,
 * so the probe goes through the raw request channel with a permissive decode.
 */
export const CodexThreadHistoryMetadata = Schema.Struct({
  thread: Schema.Struct({
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
});

export const decodeCodexThreadHistoryMetadata = Schema.decodeUnknownEffect(
  CodexThreadHistoryMetadata,
);

export const readCodexThreadHistoryMetadata: (
  raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
  threadId: string,
) => Effect.Effect<
  { readonly historyMode: "legacy" | "paginated" | undefined; readonly loaded: boolean },
  CodexErrors.CodexAppServerError
> = Effect.fn("CodexAdapterV2.readThreadHistoryMetadata")(function* (
  raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
  threadId: string,
) {
  const response = yield* raw.request("thread/read", { threadId, includeTurns: false });
  const metadata = yield* decodeCodexThreadHistoryMetadata(response).pipe(
    Effect.mapError((error) =>
      CodexErrors.CodexAppServerRequestError.invalidPayload("thread/read", "decode-payload", error),
    ),
  );
  return {
    historyMode: metadata.thread.historyMode,
    loaded: metadata.thread.status?.type !== "notLoaded",
  };
});

export const resolveCodexRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveRollbackTurnCount")(
  function* (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) {
    const providerTurns = input.providerThreadTurns;
    switch (input.target.type) {
      case "thread_start":
        return providerTurns.filter(isTerminalProviderTurn).length;
      case "provider_turn": {
        if (input.target.providerTurn.providerThreadId !== input.providerThread.id) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn belongs to provider thread ${input.target.providerTurn.providerThreadId}.`,
          });
        }

        const rollbackTurnCount = countTerminalTurnsAfterBoundary(
          providerTurns,
          input.target.providerTurn.id,
        );
        if (rollbackTurnCount === null) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn was not found in durable provider turn history.`,
          });
        }

        return rollbackTurnCount;
      }
    }
  },
);
