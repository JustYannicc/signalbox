// @ts-expect-error The shared MJS fixture has no declaration.
import { EXEC_ARGUMENTS, PATCH_INPUT } from "../codexTurn/MockResponses.mjs";
import { verifyCodexHookPayloads } from "./codexPayloads.ts";
import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createCodexHookRuntime } from "./codexRuntime.ts";
import {
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_REGISTRATIONS,
  PRE_TOOL_USE_CAPTURE_PATH,
} from "./codexScenario.ts";
import {
  verifyCodexHooks,
  CODEX_HOOK_MODES,
  type HookInvocationRecord,
  type CodexHookVerificationInput,
} from "./codexVerification.ts";

function fixture() {
  const database = createProofTestStorage();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [] },
      umask: 0o022,
    },
  });
  filesystem.mkdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const runtime = createCodexHookRuntime(
    () => ({ bindings: new Map(), async drain() {} }),
    wakes,
    new ChildWorkerCapacity(),
  );
  const configured = runtime.configure({
    filesystem,
    facetStorage: database.storage,
    host: runtime.host,
    wakes,
    env: {
      CHILD_WORKERS: {},
      CODE_GENERATION: {
        async open() {
          throw new Error("Unexpected generated execution");
        },
      },
    },
  });
  const exit = { exitCode: 0, signal: 0, coreDumped: false };
  const names = {
    "session-start": "SessionStart",
    "pre-tool-use": "PreToolUse",
    "post-tool-use": "PostToolUse",
    stop: "Stop",
  };
  const order = [0, 1, 2, 1, 2, 3];
  const invocations: HookInvocationRecord[] = order.map((registrationIndex, index) => {
    const { id, event } = CODEX_HOOK_REGISTRATIONS[registrationIndex]!;
    const tool =
      index >= 3
        ? {
            tool_name: "apply_patch",
            tool_use_id: "call-1069-apply-patch",
            tool_input: { command: PATCH_INPUT },
          }
        : {
            tool_name: "Bash",
            tool_use_id: "call-1069-exec",
            tool_input: { command: EXEC_ARGUMENTS.cmd },
          };
    const input = {
      hook_event_name: names[event],
      session_id: "native-session",
      cwd: "/workspace",
      ...(event !== "session-start" ? { turn_id: "native-turn" } : {}),
      ...(event === "pre-tool-use" || event === "post-tool-use" ? tool : {}),
      ...(event === "post-tool-use"
        ? {
            tool_response:
              index >= 3
                ? "Success. Updated the following files:\nA /workspace/proof.txt\n"
                : "codex-exec-proof\n",
          }
        : {}),
    };
    const stdout = JSON.stringify(
      event === "stop"
        ? {}
        : {
            ...(event === "post-tool-use" ? { continue: true } : {}),
            hookSpecificOutput: {
              hookEventName: names[event],
              ...(event === "pre-tool-use" ? { permissionDecision: "allow" } : {}),
              ...(event === "post-tool-use"
                ? { additionalContext: `PostToolUse payload: ${JSON.stringify(input)}` }
                : {}),
            },
          },
    );
    return {
      id,
      event,
      kind: CODEX_HOOK_MODES[event],
      input,
      startedAtMs: null,
      elapsedMs: null,
      exit,
      stdout,
    };
  });
  const pre = invocations.filter((record) => record.event === "pre-tool-use");
  const capture = new TextEncoder().encode(
    pre.map((record) => `${JSON.stringify(record.input)}\n`).join(""),
  );
  const fd = filesystem.open(
    PRE_TOOL_USE_CAPTURE_PATH,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
    0o644,
  );
  filesystem.write(fd, capture, null);
  filesystem.close(fd);
  const input: CodexHookVerificationInput = {
    filesystem,
    host: runtime.host,
    parent: configured.parent,
    invocations,
    isolateCalls: pre.map(() => ({
      executable: "/bin/bash",
      argv: [],
      cwd: "/workspace",
      startedAtMs: null,
      elapsedMs: null,
      exit,
    })),
    generatedCalls: invocations
      .filter((record) => record.event === "post-tool-use")
      .map((record) => ({
        id: "codex-post-tool-use",
        input: record.input,
        startedAtMs: null,
        elapsedMs: null,
        status: 200,
      })),
    signalboxCalls: invocations
      .filter((record) => record.kind === "signalbox")
      .map((record) => ({
        request: {
          harness: "codex",
          event: record.event,
          sessionId: "native-session",
          payload: record.input,
        },
      })),
    spawnCalls: invocations.map((record) => ({
      executable: "/bin/bash",
      argv: ["/bin/bash", "-lc", `${CODEX_HOOK_EXECUTABLE} ${record.id}`],
      cwd: "/workspace",
      startedAtMs: null,
      elapsedMs: null,
      result: "ok",
    })),
    machineAttempts: [],
  };
  return {
    input,
    invocations,
    async close() {
      await configured.finish({ exit: 0, failure: undefined });
      await runtime.host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

describe("Codex hook proof result validation", () => {
  it("accepts all six successful native hook results and both captured tool inputs", async () => {
    const test = fixture();
    try {
      expect(await verifyCodexHooks(test.input)).toMatchObject({ ok: true, failures: [] });
    } finally {
      await test.close();
    }
  });

  it.each(["malformed later JSON", "later wrong event", "signal termination", "core dump"])(
    "rejects %s after the first tool hook succeeds",
    async (failure) => {
      const test = fixture();
      try {
        const record = test.invocations.filter((record) => record.event === "pre-tool-use")[1]!;
        if (failure === "malformed later JSON") record.stdout = "not JSON";
        if (failure === "later wrong event")
          record.stdout = JSON.stringify({
            hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "allow" },
          });
        if (failure === "signal termination")
          record.exit = { exitCode: 0, signal: 15, coreDumped: false };
        if (failure === "core dump") record.exit = { exitCode: 0, signal: 0, coreDumped: true };
        const result = await verifyCodexHooks(test.input);
        const message =
          failure === "malformed later JSON"
            ? "did not return a JSON object"
            : failure === "later wrong event"
              ? "returned the wrong result event"
              : "did not complete successfully";
        expect(result.ok).toBe(false);
        expect(result.failures).toContain(`${record.id} ${message}`);
      } finally {
        await test.close();
      }
    },
  );
  it.each(["session_id", "cwd", "tool_name", "tool_use_id", "tool_input", "tool_response"])(
    "rejects a stripped native %s field",
    async (field) => {
      const test = fixture();
      try {
        const payload = test.invocations[2]!.input;
        if (typeof payload !== "object" || payload === null)
          throw new Error("Expected payload object");
        Reflect.deleteProperty(payload, field);
        const message =
          field === "session_id" || field === "cwd"
            ? "lost its native session_id or cwd"
            : field === "tool_response"
              ? "lost the real tool_response"
              : "lost the expected native tool call";
        expect(verifyCodexHookPayloads(test.invocations)).toContain(
          `${test.invocations[2]!.id} ${message}`,
        );
      } finally {
        await test.close();
      }
    },
  );

  it("rejects Stop before the tool hooks", async () => {
    const test = fixture();
    try {
      const reordered = [
        test.invocations[0]!,
        test.invocations[5]!,
        ...test.invocations.slice(1, 5),
      ];
      expect(verifyCodexHookPayloads(reordered)).toContain(
        "Native hook order differs at invocation 1",
      );
    } finally {
      await test.close();
    }
  });

  it.each([2, 3, 5])("rejects a mismatched turn_id at invocation %s", async (index) => {
    const test = fixture();
    try {
      const entry = test.invocations[index]!;
      if (typeof entry.input !== "object" || entry.input === null)
        throw new Error("Expected payload object");
      Reflect.set(entry.input, "turn_id", "another-turn");
      expect(verifyCodexHookPayloads(test.invocations)).toContain(
        `${entry.id} did not retain the native turn_id`,
      );
    } finally {
      await test.close();
    }
  });
});
