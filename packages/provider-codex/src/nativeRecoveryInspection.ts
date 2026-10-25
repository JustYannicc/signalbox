import * as Schema from "effect/Schema";
import { ClientRequest__FunctionCallOutputContentItem } from "effect-codex-app-server/schema";
import type {
  CodexNativeAdmission,
  CodexNativeInspection,
  CodexNativePendingAction,
  CodexNativeRecoveryOutcome,
  CodexNativeReceipt,
} from "./nativeRecovery.ts";

const Row = Schema.Struct({
  type: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const isRow = Schema.is(Row);
const UserMessageItemMarker = Schema.Struct({ type: Schema.Literal("UserMessage") });
const isUserMessageItem = Schema.is(UserMessageItemMarker);
const CurrentUserMessage = Schema.Struct({
  type: Schema.Literal("item_completed"),
  thread_id: Schema.String,
  turn_id: Schema.String,
  item: Schema.Struct({
    type: Schema.Literal("UserMessage"),
    client_id: Schema.String,
  }),
});
const isCurrentUserMessage = Schema.is(CurrentUserMessage);
const isNativeOutput = Schema.is(
  Schema.Union([Schema.String, Schema.Array(ClientRequest__FunctionCallOutputContentItem)]),
);

type NativeFile = CodexNativeInspection["file"] & { readonly contents: string };
type NativeHead = Omit<CodexNativeInspection, "file" | "stopped">;

function readHead(
  admission: CodexNativeAdmission,
  file: NativeFile,
):
  | { readonly status: "observed"; readonly head: NativeHead }
  | { readonly status: "indeterminate"; readonly reason: string } {
  const blocked = (reason: string) => ({ status: "indeterminate", reason }) as const;
  if (!file.contents.endsWith("\n"))
    return blocked("Native rollout ends before a complete JSONL boundary.");

  let sessionId: string | undefined;
  let turnId: string | undefined;
  let inputLine = 0;
  let inputTurnId: string | undefined;
  let state: CodexNativeInspection["state"] = "unfinished";
  let terminalStatus: "completed" | "failed" | undefined;
  const calls = new Map<string, string>();
  const lines = file.contents.trimEnd().split("\n");
  for (const [offset, line] of lines.entries()) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return blocked("Native rollout has an incomplete or invalid JSONL row.");
    }
    if (!isRow(row)) return blocked("Native rollout row shape is unsupported.");
    const p = row.payload;
    if (row.type === "session_meta") {
      if (typeof p.id !== "string" || (sessionId !== undefined && sessionId !== p.id)) {
        return blocked("Native rollout session identity is ambiguous.");
      }
      sessionId = p.id;
    }
    if (row.type === "event_msg") {
      if (inputLine > 0 && p.type === "thread_rolled_back") {
        return blocked("A native rollback changed the admitted conversation head.");
      }
      if (p.type === "task_started" || p.type === "turn_started") {
        if (typeof p.turn_id !== "string") return blocked("Native turn start has no identity.");
        turnId = p.turn_id;
        state = "unfinished";
        terminalStatus = undefined;
      }
      if (p.type === "user_message") {
        if (p.client_id === admission.nativeInputId) {
          if (inputLine !== 0)
            return blocked("Original input appears more than once in the rollout.");
          inputLine = offset + 1;
          inputTurnId = turnId;
        } else if (inputLine > 0)
          return blocked("A later native input superseded this logical run.");
      }
      if (p.type === "item_completed" && isUserMessageItem(p.item)) {
        if (!isCurrentUserMessage(p))
          return blocked("Native UserMessage event has incomplete correlation identity.");
        if (p.thread_id !== sessionId)
          return blocked("Native UserMessage belongs to a different thread.");
        if (p.item.client_id === admission.nativeInputId) {
          if (p.turn_id !== turnId)
            return blocked("Original native input turn does not match its event turn.");
          if (inputLine > 0)
            return blocked("Original input appears more than once in the rollout.");
          inputLine = offset + 1;
          inputTurnId = p.turn_id;
        } else if (inputLine > 0) {
          return blocked("A later native input superseded this logical run.");
        }
      }
      if ((p.type === "task_complete" || p.type === "turn_complete") && p.turn_id === turnId) {
        state = "completed";
        terminalStatus = p.error == null ? "completed" : "failed";
      }
      if (p.type === "turn_aborted" && (p.turn_id == null || p.turn_id === turnId))
        state = "interrupted";
    }
    if (inputLine > 0 && row.type === "response_item") {
      const id = typeof p.call_id === "string" ? p.call_id : p.id;
      if (typeof id !== "string") continue;
      if (p.type === "function_call" || p.type === "local_shell_call")
        calls.set(id, "function_call_output");
      if (p.type === "custom_tool_call") calls.set(id, "custom_tool_call_output");
      if (p.type === "tool_search_call") calls.set(id, "tool_search_output");
      if (
        ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(
          String(p.type),
        )
      ) {
        if (calls.has(id) && calls.get(id) !== p.type)
          return blocked("Native tool output kind differs from its original call.");
        if (p.type === "tool_search_output" ? !Array.isArray(p.tools) : !isNativeOutput(p.output)) {
          return blocked("Native tool output has no supported result payload.");
        }
        // Native normalization can manufacture an aborted result after a crash.
        if (
          p.output === "aborted" ||
          (Array.isArray(p.output) &&
            p.output.some(
              (item: unknown) =>
                typeof item === "object" &&
                item !== null &&
                Reflect.get(item, "type") === "input_text" &&
                Reflect.get(item, "text") === "aborted",
            ))
        )
          continue;
        calls.delete(id);
      }
    }
  }
  if (
    sessionId !== admission.nativeSessionId ||
    !turnId ||
    !inputLine ||
    (inputTurnId !== turnId &&
      (admission.inputDurability !== "native-file" || admission.nativeTurnId !== turnId))
  ) {
    return blocked("The saved native head does not prove admission of this logical input.");
  }
  if (admission.nativeTurnId !== null && admission.nativeTurnId !== turnId) {
    return blocked("The saved native turn differs from its admission receipt.");
  }
  return {
    status: "observed",
    head: {
      nativeSessionId: sessionId,
      nativeTurnId: turnId,
      nativeInputId: admission.nativeInputId,
      headLine: lines.length,
      inputLine,
      pendingNativeCallIds: [...calls.keys()],
      state,
      ...(terminalStatus === undefined ? {} : { terminalStatus }),
    },
  };
}

/** Inspect a root-verified immutable copy of the canonical rollout after physical stop. */
export function inspectCodexNativeRecovery(input: {
  readonly admission: CodexNativeAdmission;
  readonly nextNativeIncarnationId: string;
  readonly stopped: CodexNativeInspection["stopped"];
  readonly file: NativeFile;
  readonly pendingActions: ReadonlyArray<CodexNativePendingAction>;
}): CodexNativeRecoveryOutcome {
  const admission = { ...input.admission, nativeIncarnationId: input.nextNativeIncarnationId };
  if (
    input.stopped.nativeIncarnationId !== input.admission.nativeIncarnationId ||
    input.nextNativeIncarnationId === input.admission.nativeIncarnationId
  ) {
    return {
      status: "indeterminate",
      admission,
      reason: "Recovery requires a stop receipt for the previous native incarnation.",
    };
  }
  const observed = readHead(admission, input.file);
  if (observed.status === "indeterminate") return { ...observed, admission };
  const evidence: CodexNativeInspection = {
    ...observed.head,
    stopped: input.stopped,
    file: { path: input.file.path, reference: input.file.reference },
  };
  const { nativeTurnId: turnId, state, pendingNativeCallIds } = observed.head;
  const durableAdmission: CodexNativeAdmission = {
    ...admission,
    nativeTurnId: turnId,
    inputDurability: "native-file",
  };
  for (const action of input.pendingActions) {
    if (action.state === "attached" || action.state === "not-accepted") continue;
    const status =
      action.state === "unknown"
        ? "indeterminate"
        : action.state === "running" || action.kind === "approval"
          ? "waiting"
          : "unsupported";
    return {
      status,
      admission: durableAdmission,
      evidence,
      pendingAction: action,
      ...(action.kind === "approval" ? { canDeliverStoredAnswer: false as const } : {}),
      reason:
        action.kind === "approval"
          ? "A lost native approval responder cannot accept an old request ID."
          : "Reconcile the existing execution and its native result attachment before continuation.",
    };
  }
  if (pendingNativeCallIds.length > 0)
    return {
      status: "unsupported",
      admission: durableAdmission,
      evidence,
      reason:
        "Native tool outputs are missing. Reopening can synthesize aborted outputs and repeat effects.",
    };
  if (state === "interrupted")
    return {
      status: "unsupported",
      admission: durableAdmission,
      evidence,
      reason: "An explicitly interrupted native turn is not eligible for automatic crash recovery.",
    };
  if (state === "completed")
    return {
      status: "completed",
      admission: durableAdmission,
      evidence,
      result: input.file.reference,
    };
  return { status: "ready", admission: durableAdmission, evidence };
}

/** The caller verifies that this reference is durably saved by the canonical Computer. */
export function confirmCodexNativeAdmission(input: {
  readonly receipt: CodexNativeReceipt;
  readonly file: NativeFile;
}): CodexNativeReceipt {
  const { receipt } = input;
  const blocked = (reason: string): CodexNativeReceipt => ({
    ...receipt,
    status: "indeterminate",
    operation: "native-file",
    reason,
  });
  if (
    (receipt.status !== "native-accepted" && receipt.status !== "continued") ||
    receipt.nativeTurnId === null
  ) {
    return blocked(
      "Native acceptance must be observed before file durability can be acknowledged.",
    );
  }
  const observed = readHead(
    { ...receipt.admission, nativeTurnId: receipt.nativeTurnId },
    input.file,
  );
  if (observed.status === "indeterminate") return blocked(observed.reason);
  if (observed.head.state === "interrupted")
    return blocked("The admitted native turn was interrupted.");
  return {
    ...receipt,
    status: "native-admitted",
    operation: "native-file",
    admission: {
      ...receipt.admission,
      nativeTurnId: receipt.nativeTurnId,
      inputDurability: "native-file",
    },
    nativeFile: { path: input.file.path, reference: input.file.reference },
  };
}
