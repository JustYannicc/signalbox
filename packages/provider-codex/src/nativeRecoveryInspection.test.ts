import { describe, expect, it } from "vite-plus/test";
import {
  confirmCodexNativeAdmission,
  inspectCodexNativeRecovery,
  prepareCodexNativeAdmission,
  type CodexNativePendingAction,
  type CodexNativeReceipt,
} from "@signalbox/provider-codex/runtime";

const admission = prepareCodexNativeAdmission({
  logicalRunId: "run",
  nativeIncarnationId: "boot-1",
  nativeSessionId: "session",
  nativeFiles: { filesystemId: "files", home: "/codex" },
  providerRelease: "R8",
  inputId: "input",
});
const reference = { id: "stop", bytes: 4, sha256: "0".repeat(64) };
const meta = { type: "session_meta", payload: { id: "session" } };
const started = { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } };
const user = {
  type: "event_msg",
  payload: { type: "user_message", client_id: "input", message: "original" },
};
const completed = { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } };
const call = {
  type: "response_item",
  payload: { type: "function_call", call_id: "call-1", name: "exec" },
};
const output = (text: string) => ({
  type: "response_item",
  payload: { type: "function_call_output", call_id: "call-1", output: text },
});

function file(rows: ReadonlyArray<unknown>) {
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return {
    path: "/codex/sessions/session.jsonl",
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
  pendingActions: ReadonlyArray<CodexNativePendingAction> = [],
) {
  return inspectCodexNativeRecovery({
    admission,
    nextNativeIncarnationId: "boot-2",
    stopped: { nativeIncarnationId: "boot-1", reference },
    file: file(rows),
    pendingActions,
  });
}

describe("Codex native-file recovery inspection", () => {
  it("reserves the original input identity, then prepares the same logical run from persisted native input", () => {
    expect(admission.inputDurability).toBe("reserved");
    const result = inspect([meta, started, user]);
    expect(result.status).toBe("ready");
    expect(result.admission).toMatchObject({
      logicalRunId: "run",
      nativeSessionId: "session",
      nativeIncarnationId: "boot-2",
      nativeInputId: "input",
      nativeTurnId: "turn-1",
      inputDurability: "native-file",
    });
  });
  it("reconciles an already completed native head", () => {
    expect(inspect([meta, started, user, completed])).toMatchObject({
      status: "completed",
      result: file([meta, started, user, completed]).reference,
    });
  });
  it("refuses a head changed by native rollback", () => {
    expect(
      inspect([
        meta,
        started,
        user,
        completed,
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      ]).status,
    ).toBe("indeterminate");
  });
  it("retains native terminal failure rather than turning it into success", () => {
    expect(
      inspect([
        meta,
        started,
        user,
        { ...completed, payload: { ...completed.payload, error: { message: "model failed" } } },
      ]),
    ).toMatchObject({ status: "completed", evidence: { terminalStatus: "failed" } });
  });
  it.each([
    ["unknown", "command", "indeterminate"],
    ["running", "command", "waiting"],
    ["completed", "result", "unsupported"],
    ["answered", "approval", "waiting"],
  ] as const)("blocks a %s %s without replaying it", (state, kind, status) => {
    const action = { id: "call-1", kind, state, reference };
    expect(inspect([meta, started, user], [action])).toMatchObject({
      status,
      pendingAction: action,
    });
    if (kind === "approval") {
      expect(inspect([meta, started, user], [action])).toMatchObject({
        canDeliverStoredAnswer: false,
      });
    }
  });
  it("blocks missing and synthetic aborted outputs even when root has a completed execution", () => {
    const action: CodexNativePendingAction = {
      id: "call-1",
      kind: "command",
      state: "attached",
      reference,
    };
    expect(inspect([meta, started, user, call]).status).toBe("unsupported");
    expect(inspect([meta, started, user, call, output("aborted")], [action]).status).toBe(
      "unsupported",
    );
    expect(inspect([meta, started, user, call, output("real result")], [action]).status).toBe(
      "ready",
    );
  });
  it("requires complete, correctly typed native tool result payloads", () => {
    const row = (payload: unknown) => ({ type: "response_item", payload });
    const base = { type: "function_call_output", call_id: "call-1" };
    expect(inspect([meta, started, user, call, row(base)]).status).toBe("indeterminate");
    expect(inspect([meta, started, user, call, row({ ...base, output: {} })]).status).toBe(
      "indeterminate",
    );
    expect(
      inspect([meta, started, user, call, row({ ...base, output: [{ type: "input_text" }] })])
        .status,
    ).toBe("indeterminate");
    expect(
      inspect([
        meta,
        started,
        user,
        call,
        row({ ...base, type: "custom_tool_call_output", output: "result" }),
      ]).status,
    ).toBe("indeterminate");
    expect(
      inspect([
        meta,
        started,
        user,
        call,
        row({ ...base, output: [{ type: "input_text", text: "aborted" }] }),
      ]).status,
    ).toBe("unsupported");
    expect(
      inspect([
        meta,
        started,
        user,
        call,
        row({ ...base, output: [{ type: "input_text", text: "real result" }] }),
      ]).status,
    ).toBe("ready");
  });
  it("rejects unadmitted, superseded, interrupted and torn native state", () => {
    expect(inspect([meta, started]).status).toBe("indeterminate");
    expect(
      inspect([meta, started, user, { ...user, payload: { ...user.payload, client_id: "later" } }])
        .status,
    ).toBe("indeterminate");
    expect(
      inspect([
        meta,
        started,
        user,
        {
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
        },
      ]).status,
    ).toBe("unsupported");
    const snapshot = file([meta, started, user]);
    expect(
      inspectCodexNativeRecovery({
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
      inspectCodexNativeRecovery({
        admission,
        nextNativeIncarnationId: "boot-2",
        stopped: { nativeIncarnationId: "wrong-boot", reference },
        file: file([meta, started, user]),
        pendingActions: [],
      }).status,
    ).toBe("indeterminate");
  });
});

describe("Codex native admission at the closed external gate", () => {
  const receipt: CodexNativeReceipt = {
    status: "native-accepted",
    operation: "turn/start",
    admission,
    nativeTurnId: "turn-1",
  };
  it("requires both observed acceptance and matching canonical file bytes", () => {
    expect(
      confirmCodexNativeAdmission({
        receipt: { ...receipt, status: "reserved" },
        file: file([meta, started, user]),
      }).status,
    ).toBe("indeterminate");
    expect(confirmCodexNativeAdmission({ receipt, file: file([meta, started]) }).status).toBe(
      "indeterminate",
    );
    expect(
      confirmCodexNativeAdmission({ receipt, file: file([meta, started, user]) }),
    ).toMatchObject({
      status: "native-admitted",
      admission: { inputDurability: "native-file" },
      nativeFile: { path: "/codex/sessions/session.jsonl" },
    });
    expect(
      confirmCodexNativeAdmission({
        receipt: { ...receipt, nativeTurnId: "wrong-turn" },
        file: file([meta, started, user]),
      }).status,
    ).toBe("indeterminate");
  });
  it("admits a replacement native turn without inserting another user message", () => {
    const next = { ...started, payload: { ...started.payload, turn_id: "turn-2" } };
    expect(
      confirmCodexNativeAdmission({
        receipt: {
          ...receipt,
          nativeTurnId: "turn-2",
          admission: { ...admission, inputDurability: "native-file", nativeTurnId: "turn-1" },
        },
        file: file([meta, started, user, next]),
      }).status,
    ).toBe("native-admitted");
    expect(
      confirmCodexNativeAdmission({
        receipt: { ...receipt, nativeTurnId: "turn-2" },
        file: file([meta, started, user, next]),
      }).status,
    ).toBe("indeterminate");
  });
});
