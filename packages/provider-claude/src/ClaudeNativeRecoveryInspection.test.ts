import { describe, expect, it } from "vite-plus/test";
import {
  confirmClaudeNativeAdmission,
  inspectClaudeNativeRecovery,
  type ClaudeNativeAdmission,
  type ClaudeNativePendingAction,
  type ClaudeNativeReceipt,
} from "@signalbox/provider-claude/ClaudeAdapter";

const admission: ClaudeNativeAdmission = {
  logicalRunId: "run",
  nativeIncarnationId: "boot-1",
  nativeSessionId: "session",
  nativeFiles: { filesystemId: "files", home: "/claude" },
  providerRelease: "2.1.302/0.3.276",
  inputId: "input",
  nativeInputId: "00000000-0000-4000-8000-000000000001",
  nativeTurnId: null,
  inputDurability: "reserved",
};
const reference = { id: "stop", bytes: 4, sha256: "0".repeat(64) };
const user = {
  type: "user",
  uuid: admission.nativeInputId,
  sessionId: "session",
  message: { role: "user", content: "original" },
};
const assistant = (content: ReadonlyArray<unknown>, stop_reason: string | null = null) => ({
  type: "assistant",
  uuid: "assistant",
  parentUuid: admission.nativeInputId,
  sessionId: "session",
  message: { role: "assistant", content, stop_reason },
});
const partial = assistant([{ type: "text", text: "partial" }]);
const completed = assistant([{ type: "text", text: "done" }], "end_turn");
const call = assistant(
  [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "effect" } }],
  "tool_use",
);
const output = (is_error: boolean) => ({
  type: "user",
  uuid: "result",
  parentUuid: "assistant",
  sessionId: "session",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result", is_error }],
  },
});

function file(rows: ReadonlyArray<unknown>) {
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return {
    path: "/claude/projects/session.jsonl",
    contents,
    reference: {
      id: "native-file",
      bytes: new TextEncoder().encode(contents).byteLength,
      sha256: "1".repeat(64),
    },
  };
}
function inspect(
  rows: ReadonlyArray<unknown>,
  pendingActions: ReadonlyArray<ClaudeNativePendingAction> = [],
) {
  return inspectClaudeNativeRecovery({
    admission,
    nextNativeIncarnationId: "boot-2",
    stopped: { nativeIncarnationId: "boot-1", reference },
    file: file(rows),
    pendingActions,
  });
}

describe("Claude native JSONL recovery inspection", () => {
  it("preserves the logical run, native session and original prompt identity", () => {
    const result = inspect([user, partial]);
    expect(result.status).toBe("ready");
    expect(result.admission).toMatchObject({
      logicalRunId: "run",
      nativeSessionId: "session",
      nativeIncarnationId: "boot-2",
      nativeInputId: admission.nativeInputId,
      nativeTurnId: null,
      inputDurability: "native-file",
    });
  });
  it("reconciles an already completed native head without rescue", () => {
    expect(inspect([user, completed])).toMatchObject({
      status: "completed",
      result: file([user, completed]).reference,
    });
  });
  it("refuses an unrelated native branch and reconciles a later successful head after an API error", () => {
    expect(inspect([user, { ...completed, parentUuid: "unrelated" }]).status).toBe("indeterminate");
    expect(
      inspect([
        user,
        { ...partial, isApiErrorMessage: true },
        { ...completed, uuid: "recovered", parentUuid: "assistant" },
      ]).status,
    ).toBe("completed");
  });
  it.each([
    ["unknown", "command", "indeterminate"],
    ["running", "command", "waiting"],
    ["completed", "result", "unsupported"],
    ["answered", "approval", "waiting"],
  ] as const)("blocks a %s %s without replaying it", (state, kind, status) => {
    const action = { id: "tool-1", kind, state, reference };
    expect(inspect([user, partial], [action])).toMatchObject({ status, pendingAction: action });
    if (kind === "approval") {
      expect(inspect([user, partial], [action])).toMatchObject({ canDeliverStoredAnswer: false });
    }
  });
  it("requires native tool results and refuses unqualified shutdown unwind outputs", () => {
    expect(inspect([user, call]).status).toBe("unsupported");
    expect(inspect([user, call, output(true)]).status).toBe("unsupported");
    expect(inspect([user, call, output(false)]).status).toBe("ready");
  });
  it("requires actual supported native tool result content", () => {
    const row = (content: unknown) => ({
      ...output(false),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content }] },
    });
    expect(inspect([user, call, row(undefined)]).status).toBe("indeterminate");
    expect(inspect([user, call, row({})]).status).toBe("indeterminate");
    expect(inspect([user, call, row([{ type: "text" }])]).status).toBe("indeterminate");
    expect(inspect([user, call, row("")]).status).toBe("ready");
    expect(inspect([user, call, row([{ type: "text", text: "real result" }])]).status).toBe(
      "ready",
    );
  });
  it("refuses a sibling result that is absent from the unfinished head's parent chain", () => {
    const sibling = { ...partial, uuid: "sibling", parentUuid: "assistant" };
    expect(inspect([user, call, output(false), sibling]).status).toBe("indeterminate");
  });
  it.each(["[Request interrupted by user]", "[Request interrupted by user for tool use]"])(
    "distinguishes shutdown and deliberate stop markers with exact content %s",
    (text) => {
      const marker = {
        ...output(false),
        uuid: "stop",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      expect(inspect([user, partial, { ...marker, interruptedByShutdown: true }]).status).toBe(
        "ready",
      );
      expect(inspect([user, partial, marker]).status).toBe("unsupported");
    },
  );
  it("recognizes a completed stop_sequence only with valid text and no unresolved calls", () => {
    expect(
      inspect([user, assistant([{ type: "text", text: "done" }], "stop_sequence")]).status,
    ).toBe("completed");
    expect(inspect([user, assistant([], "stop_sequence")]).status).toBe("indeterminate");
    expect(
      inspect([user, { ...call, message: { ...call.message, stop_reason: "stop_sequence" } }])
        .status,
    ).toBe("indeterminate");
  });
  it("does not rescue a deliberate interruption even with partial output after its marker", () => {
    const marker = {
      ...user,
      uuid: "stop",
      parentUuid: admission.nativeInputId,
      message: { role: "user", content: "[Request interrupted by user]" },
    };
    expect(inspect([user, marker, { ...partial, parentUuid: "stop" }]).status).toBe("unsupported");
  });
  it("rejects missing, later, repeated, wrong-session and torn native inputs", () => {
    expect(inspect([partial]).status).toBe("indeterminate");
    expect(inspect([user, { ...user, uuid: "later" }]).status).toBe("indeterminate");
    expect(inspect([user, user]).status).toBe("indeterminate");
    expect(inspect([{ ...user, sessionId: "other" }]).status).toBe("indeterminate");
    const snapshot = file([user]);
    expect(
      inspectClaudeNativeRecovery({
        admission,
        nextNativeIncarnationId: "boot-2",
        stopped: { nativeIncarnationId: "boot-1", reference },
        file: { ...snapshot, contents: snapshot.contents.slice(0, -1) },
        pendingActions: [],
      }).status,
    ).toBe("indeterminate");
  });
  it("requires stop evidence for the previous incarnation", () => {
    expect(
      inspectClaudeNativeRecovery({
        admission,
        nextNativeIncarnationId: "boot-2",
        stopped: { nativeIncarnationId: "wrong-boot", reference },
        file: file([user]),
        pendingActions: [],
      }).status,
    ).toBe("indeterminate");
  });
});

describe("Claude native admission at the closed external gate", () => {
  const receipt: ClaudeNativeReceipt = {
    status: "native-accepted",
    operation: "prompt/offer",
    admission,
    nativePromptId: admission.nativeInputId,
    nativeMessageId: null,
  };
  it("requires native start evidence and the matching saved UUID for a fresh turn", () => {
    expect(
      confirmClaudeNativeAdmission({
        mode: "new-turn",
        receipt: { ...receipt, status: "reserved" },
        file: file([user]),
      }).status,
    ).toBe("indeterminate");
    expect(
      confirmClaudeNativeAdmission({ mode: "new-turn", receipt, file: file([partial]) }).status,
    ).toBe("indeterminate");
    expect(
      confirmClaudeNativeAdmission({ mode: "new-turn", receipt, file: file([user]) }),
    ).toMatchObject({ status: "indeterminate" });
    expect(
      confirmClaudeNativeAdmission({
        mode: "new-turn",
        receipt: { ...receipt, status: "continued", operation: "command_lifecycle" },
        file: file([user]),
      }),
    ).toMatchObject({ status: "native-admitted", admission: { inputDurability: "native-file" } });
  });
  it("requires a real observed native start for rescue, even when old JSONL contains the UUID", () => {
    expect(
      confirmClaudeNativeAdmission({
        mode: "resume-unfinished",
        receipt,
        file: file([user, partial]),
      }).status,
    ).toBe("indeterminate");
    expect(
      confirmClaudeNativeAdmission({
        mode: "resume-unfinished",
        receipt: {
          ...receipt,
          status: "continued",
          operation: "stream_event/message_start",
          nativeMessageId: "new-native-message",
        },
        file: file([user, partial]),
      }).status,
    ).toBe("native-admitted");
  });
  it("admits at the intercepted native model request before any model response, with exact incarnation correlation", () => {
    const modelRequest = {
      logicalRunId: admission.logicalRunId,
      nativeIncarnationId: admission.nativeIncarnationId,
      nativeSessionId: admission.nativeSessionId,
      reference,
    };
    const reserved: ClaudeNativeReceipt = { ...receipt, status: "reserved" };
    expect(
      confirmClaudeNativeAdmission({
        mode: "resume-unfinished",
        receipt: reserved,
        file: file([user, partial]),
        modelRequest,
      }),
    ).toMatchObject({ status: "native-admitted", nativeModelRequest: reference });
    expect(
      confirmClaudeNativeAdmission({
        mode: "resume-unfinished",
        receipt: reserved,
        file: file([user, partial]),
        modelRequest: { ...modelRequest, nativeIncarnationId: "stale-boot" },
      }).status,
    ).toBe("indeterminate");
    expect(
      confirmClaudeNativeAdmission({
        mode: "resume-unfinished",
        receipt: { ...reserved, status: "indeterminate" },
        file: file([user, partial]),
        modelRequest,
      }).status,
    ).toBe("indeterminate");
  });
});
