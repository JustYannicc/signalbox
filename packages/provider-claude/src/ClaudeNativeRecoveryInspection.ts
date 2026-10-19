import * as Schema from "effect/Schema";
import type {
  ClaudeNativeAdmission,
  ClaudeNativeInspection,
  ClaudeNativePendingAction,
  ClaudeNativeRecoveryOutcome,
  ClaudeNativeReceipt,
  ClaudeNativeModelRequest,
} from "./ClaudeNativeRecovery.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isContent = Schema.is(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));
const isNativeToolResult = Schema.is(
  Schema.Union([
    Schema.String,
    Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  ]),
);

type NativeFile = ClaudeNativeInspection["file"] & { readonly contents: string };
type NativeHead = Omit<ClaudeNativeInspection, "file" | "stopped">;

function readHead(
  admission: ClaudeNativeAdmission,
  file: NativeFile,
):
  | { readonly status: "observed"; readonly head: NativeHead }
  | { readonly status: "indeterminate"; readonly reason: string } {
  const blocked = (reason: string) => ({ status: "indeterminate", reason }) as const;
  if (!file.contents.endsWith("\n"))
    return blocked("Native session ends before a complete JSONL boundary.");
  let inputLine = 0;
  let state: ClaudeNativeInspection["state"] = "unfinished";
  let explicitlyInterrupted = false;
  let apiErrorAtHead = false;
  let headUuid: string | undefined;
  let lastStopReason: unknown;
  const seenMessages = new Set<string>();
  const calls = new Set<string>();
  const lines = file.contents.trimEnd().split("\n");
  for (const [offset, line] of lines.entries()) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return blocked("Native session has an incomplete or invalid JSONL row.");
    }
    if (!isRecord(row)) return blocked("Native JSONL row shape is unsupported.");
    if (row.isSidechain === true) continue;
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.sessionId !== admission.nativeSessionId || !isRecord(row.message)) {
      return blocked("Native JSONL session identity or message shape does not match.");
    }
    const content = row.message.content;
    const blocks = isContent(content) ? content : [];
    const text =
      typeof content === "string"
        ? content
        : blocks.length === 1 && blocks[0]?.type === "text"
          ? blocks[0].text
          : undefined;
    // Native c6t recognizes these exact stop markers; only shutdown-stamped ones resume.
    const isStopMarker =
      row.type === "user" &&
      (text === "[Request interrupted by user]" ||
        text === "[Request interrupted by user for tool use]");
    const isPrompt =
      row.type === "user" &&
      !isStopMarker &&
      row.isMeta !== true &&
      (typeof content === "string" ||
        blocks.some((block) => block.type === "text" || block.type === "image"));
    if (isPrompt) {
      if (row.uuid === admission.nativeInputId) {
        if (inputLine !== 0)
          return blocked("Original prompt UUID appears more than once in the session.");
        inputLine = offset + 1;
        seenMessages.add(admission.nativeInputId);
        headUuid = admission.nativeInputId;
      } else if (inputLine > 0)
        return blocked("A later native prompt superseded this logical run.");
    }
    if (!inputLine) continue;
    if (offset + 1 !== inputLine) {
      if (
        typeof row.uuid !== "string" ||
        seenMessages.has(row.uuid) ||
        row.parentUuid !== headUuid
      ) {
        return blocked("Native messages branch, repeat, or do not form one admitted parent chain.");
      }
      seenMessages.add(row.uuid);
      headUuid = row.uuid;
    }
    if (isStopMarker) {
      if (row.interruptedByShutdown === true) state = "unfinished";
      else explicitlyInterrupted = true;
    }
    for (const block of blocks) {
      if (block.type === "tool_use" && typeof block.id === "string") calls.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        // Shutdown unwind rows do not prove whether an external effect completed.
        if (!isNativeToolResult(block.content)) {
          return blocked(
            "Native tool result content is missing or needs an unsupported multimodal decoder.",
          );
        }
        if (block.is_error !== true) calls.delete(block.tool_use_id);
      }
    }
    if (row.type === "assistant") {
      apiErrorAtHead = row.isApiErrorMessage === true;
      lastStopReason = row.message.stop_reason;
      state =
        (lastStopReason === "end_turn" || lastStopReason === "stop_sequence") &&
        blocks.some(
          (block) =>
            block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
        )
          ? "completed"
          : "unfinished";
    }
  }
  if (!inputLine)
    return blocked("The saved native session does not prove admission of this prompt UUID.");
  if (apiErrorAtHead)
    return blocked("The native tail is an API error, so rescue eligibility is unknown.");
  if (lastStopReason === "stop_sequence" && (state !== "completed" || calls.size > 0))
    return blocked(
      "The native stop_sequence does not prove a completed text reply with all results.",
    );
  if (explicitlyInterrupted) state = "interrupted";
  return {
    status: "observed",
    head: {
      nativeSessionId: admission.nativeSessionId,
      nativeInputId: admission.nativeInputId,
      headLine: lines.length,
      inputLine,
      pendingNativeCallIds: [...calls],
      state,
    },
  };
}

/** Inspect a root-verified immutable copy of the canonical JSONL after physical stop. */
export function inspectClaudeNativeRecovery(input: {
  readonly admission: ClaudeNativeAdmission;
  readonly nextNativeIncarnationId: string;
  readonly stopped: ClaudeNativeInspection["stopped"];
  readonly file: NativeFile;
  readonly pendingActions: ReadonlyArray<ClaudeNativePendingAction>;
}): ClaudeNativeRecoveryOutcome {
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
  const evidence: ClaudeNativeInspection = {
    ...observed.head,
    stopped: input.stopped,
    file: { path: input.file.path, reference: input.file.reference },
  };
  const { state, pendingNativeCallIds } = observed.head;
  const durableAdmission: ClaudeNativeAdmission = { ...admission, inputDurability: "native-file" };
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
          ? "The local SDK has no qualified restoration API for this parked approval."
          : "Reconcile the existing execution and its native result attachment before continuation.",
    };
  }
  if (pendingNativeCallIds.length > 0)
    return {
      status: "unsupported",
      admission: durableAdmission,
      evidence,
      reason:
        "The local SDK has no qualified served-call adoption API for these unresolved tool uses.",
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
export function confirmClaudeNativeAdmission(input: {
  readonly mode: "new-turn" | "resume-unfinished";
  readonly receipt: ClaudeNativeReceipt;
  readonly file: NativeFile;
  readonly modelRequest?: ClaudeNativeModelRequest;
}): ClaudeNativeReceipt {
  const { receipt } = input;
  const blocked = (reason: string): ClaudeNativeReceipt => ({
    ...receipt,
    status: "indeterminate",
    operation: "native-file",
    reason,
  });
  if (
    receipt.status !== "reserved" &&
    receipt.status !== "native-accepted" &&
    receipt.status !== "continued"
  ) {
    return blocked("An uncertain or terminal native receipt cannot authorize generation.");
  }
  if (
    input.modelRequest !== undefined &&
    (input.modelRequest.logicalRunId !== receipt.admission.logicalRunId ||
      input.modelRequest.nativeIncarnationId !== receipt.admission.nativeIncarnationId ||
      input.modelRequest.nativeSessionId !== receipt.admission.nativeSessionId)
  )
    return blocked("The native model request belongs to another run, session or incarnation.");
  if (
    input.modelRequest === undefined &&
    (receipt.status !== "continued" ||
      (receipt.operation !== "command_lifecycle" &&
        receipt.operation !== "stream_event/message_start"))
  ) {
    return blocked("Native recovery must start before file durability can be acknowledged.");
  }
  const observed = readHead(receipt.admission, input.file);
  if (observed.status === "indeterminate") return blocked(observed.reason);
  if (observed.head.state === "interrupted")
    return blocked("The admitted native turn was interrupted.");
  return {
    ...receipt,
    status: "native-admitted",
    operation: "native-file",
    admission: { ...receipt.admission, inputDurability: "native-file" },
    nativeFile: { path: input.file.path, reference: input.file.reference },
    ...(input.modelRequest === undefined
      ? {}
      : { nativeModelRequest: input.modelRequest.reference }),
  };
}
