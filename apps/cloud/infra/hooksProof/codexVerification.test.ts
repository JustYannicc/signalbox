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
  CODEX_ALL_HOOK_REGISTRATIONS,
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_REGISTRATIONS,
  CODEX_STANDARD_HOOK_REGISTRATIONS,
  PRE_TOOL_USE_CAPTURE_PATH,
} from "./codexScenario.ts";
import { STANDARD_PROOF_NAMED_SECRET } from "./standardProofAdapter.ts";
import {
  verifyCodexHooks,
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
  const registrations = new Map<string, (typeof CODEX_ALL_HOOK_REGISTRATIONS)[number]>(
    CODEX_ALL_HOOK_REGISTRATIONS.map((entry) => [entry.id, entry]),
  );
  function makeInvocation(id: string, toolIndex?: 0 | 1): HookInvocationRecord {
    const route = registrations.get(id);
    if (!route) throw new Error(`Unknown test hook id ${id}`);
    const { event } = route;
    const tool =
      toolIndex === 1
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
              toolIndex === 1
                ? "Success. Updated the following files:\nA /workspace/proof.txt\n"
                : "codex-exec-proof\n",
          }
        : {}),
    };
    const isStandard = CODEX_STANDARD_HOOK_REGISTRATIONS.some((entry) => entry.id === id);
    const stdout = JSON.stringify(
      isStandard || event === "stop"
        ? {}
        : event === "session-start"
          ? {
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: "Signalbox received the Codex SessionStart event.",
              },
            }
          : event === "pre-tool-use"
            ? {
                hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
              }
            : {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: `PostToolUse payload: ${JSON.stringify(input)}`,
                },
              },
    );
    return {
      id,
      event,
      kind: route.kind,
      input,
      startedAtMs: null,
      elapsedMs: null,
      exit,
      stdout,
      ...(id === CODEX_HOOK_REGISTRATIONS[1]!.id ? { stderr: "{{secret:API_TOKEN}}\n" } : {}),
    };
  }
  const invocations: HookInvocationRecord[] = [
    makeInvocation(CODEX_HOOK_REGISTRATIONS[0]!.id),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[1]!.id, 0),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[0]!.id, 0),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[2]!.id, 0),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[1]!.id, 0),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[1]!.id, 1),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[0]!.id, 1),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[2]!.id, 1),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[1]!.id, 1),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[3]!.id),
  ];
  const pre = invocations.filter((record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id);
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
      .filter((record) => record.id === CODEX_HOOK_REGISTRATIONS[2]!.id)
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
    standard: {
      ok: true,
      gateway: { beforeToolUse: 2, afterToolUse: 2, commandEnvironments: 2 },
    },
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
  it("accepts ten native hook runs while checking both six-event paths", async () => {
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
        const originalPre = test.invocations.filter(
          (record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id,
        );
        const record = originalPre[1]!;
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
        const record = test.invocations.find(
          (entry) => entry.id === CODEX_HOOK_REGISTRATIONS[2]!.id,
        )!;
        const payload = record.input;
        if (typeof payload !== "object" || payload === null)
          throw new Error("Expected payload object");
        Reflect.deleteProperty(payload, field);
        const message =
          field === "session_id" || field === "cwd"
            ? "lost its native session_id or cwd"
            : field === "tool_response"
              ? "lost the real tool_response"
              : "lost the expected native tool call";
        expect(verifyCodexHookPayloads(test.invocations)).toContain(`${record.id} ${message}`);
      } finally {
        await test.close();
      }
    },
  );

  it("rejects Stop before the tool hooks", async () => {
    const test = fixture();
    try {
      const originals = test.invocations.filter((record) =>
        CODEX_HOOK_REGISTRATIONS.some((registration) => registration.id === record.id),
      );
      const reordered = [originals[0]!, originals[5]!, ...originals.slice(1, 5)];
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
      const originals = test.invocations.filter((record) =>
        CODEX_HOOK_REGISTRATIONS.some((registration) => registration.id === record.id),
      );
      const entry = originals[index]!;
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

  it("requires scrubbed command stderr and keeps an accidental raw secret out of its report", async () => {
    const test = fixture();
    const rawSecret = STANDARD_PROOF_NAMED_SECRET.value;
    try {
      const pre = test.invocations.find((record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id)!;
      pre.stderr = `${rawSecret}\n`;
      const result = await verifyCodexHooks(test.input);
      expect(result.ok).toBe(false);
      expect(result.failures).toContain(
        `${pre.id} did not scrub the command environment from stderr`,
      );
      expect(JSON.stringify(result)).not.toContain(rawSecret);
    } finally {
      await test.close();
    }
  });

  it("requires Gateway before, after, and command environment activity", async () => {
    const test = fixture();
    try {
      Reflect.set(test.input.standard, "gateway", {
        beforeToolUse: 0,
        afterToolUse: 0,
        commandEnvironments: 0,
      });
      const result = await verifyCodexHooks(test.input);
      expect(result.ok).toBe(false);
      expect(result.failures).toContain(
        "Standard hook proof recorded no Gateway beforeToolUse activity",
      );
      expect(result.failures).toContain(
        "Standard hook proof recorded no Gateway afterToolUse activity",
      );
      expect(result.failures).toContain(
        "Standard hook proof recorded no Gateway commandEnvironments activity",
      );
    } finally {
      await test.close();
    }
  });
});
