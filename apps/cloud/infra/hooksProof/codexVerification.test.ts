// @ts-expect-error The shared MJS fixture has no declaration.
import { CODEX_SECRET_READ_COMMAND, EXEC_ARGUMENTS } from "../codexTurn/MockResponses.mjs";
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
import {
  scrubStandardProofRecord,
  standardProofFilledWrite,
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_WRITE,
} from "./standardProofAdapter.ts";
import { CODEX_SECRET_PATCH_INPUT, CODEX_SECRET_PROOF_WIRE_TEXT } from "./codexPayloads.ts";
import {
  verifyCodexHooks,
  type HookInvocationRecord,
  type CodexHookVerificationInput,
} from "./codexVerification.ts";

function fixture(bashPostToolUseResponse = "codex-exec-proof\n") {
  const database = createProofTestStorage();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
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
    storage,
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
  function makeInvocation(id: string, toolIndex?: 0 | 1 | 2): HookInvocationRecord {
    const route = registrations.get(id);
    if (!route) throw new Error(`Unknown test hook id ${id}`);
    const { event } = route;
    const tool =
      toolIndex === 1
        ? {
            tool_name: "apply_patch",
            tool_use_id: "call-1069-apply-patch",
            tool_input: { command: CODEX_SECRET_PATCH_INPUT },
          }
        : toolIndex === 2
          ? {
              tool_name: "Bash",
              tool_use_id: "call-1242-secret-read",
              tool_input: { command: CODEX_SECRET_READ_COMMAND },
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
                : toolIndex === 2
                  ? CODEX_SECRET_PROOF_WIRE_TEXT
                  : bashPostToolUseResponse,
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
    makeInvocation(CODEX_HOOK_REGISTRATIONS[1]!.id, 2),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[0]!.id, 2),
    makeInvocation(CODEX_HOOK_REGISTRATIONS[2]!.id, 2),
    makeInvocation(CODEX_STANDARD_HOOK_REGISTRATIONS[1]!.id, 2),
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
  const proofFile = filesystem.open(
    "/workspace/proof.txt",
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
    0o644,
  );
  filesystem.write(proofFile, new TextEncoder().encode(STANDARD_PROOF_WRITE), null);
  filesystem.close(proofFile);
  const nativeFileRead = {
    executable: "/bin/bash",
    argv: ["bash", "-c", CODEX_SECRET_READ_COMMAND],
    stdout: new TextEncoder().encode(standardProofFilledWrite()),
  };
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
    nativeFileRead,
    standard: {
      ok: true,
      gateway: { beforeToolUse: 3, afterToolUse: 3, commandEnvironments: 3 },
    },
  };
  return {
    input,
    invocations,
    nativeFileRead,
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
  it("accepts fourteen native hook runs while checking all three tool events", async () => {
    const test = fixture();
    try {
      const result = await verifyCodexHooks(test.input);
      expect(result).toMatchObject({
        ok: true,
        failures: [],
        nativeFileFill: {
          kind: "official-apply-patch-then-bash-cat",
          commandMatched: true,
          matchesFilledBytes: true,
          canonicalMatchesPlaceholders: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain(standardProofFilledWrite());
    } finally {
      await test.close();
    }
  });

  it("checks the selected exec against its terminal poll output while preserving the cat hook", async () => {
    const test = fixture("complete\n");
    try {
      const result = await verifyCodexHooks({
        ...test.input,
        bashExpectation: {
          command: EXEC_ARGUMENTS.cmd,
          output: "full aggregate output\n",
          postToolUseResponse: () => "complete\n",
        },
      });
      expect(result).toMatchObject({ ok: true, failures: [] });
      expect(JSON.stringify(result)).not.toContain(standardProofFilledWrite());
    } finally {
      await test.close();
    }
  });

  it.each([
    ["aggregate output", () => "full aggregate output\n"],
    ["missing output", () => undefined],
    ["non-string output", () => 42],
    [
      "throwing getter",
      () => {
        throw new Error("unavailable");
      },
    ],
  ])("rejects %s from the terminal response getter", async (_label, postToolUseResponse) => {
    const test = fixture("complete\n");
    try {
      const result = await verifyCodexHooks({
        ...test.input,
        bashExpectation: {
          command: EXEC_ARGUMENTS.cmd,
          output: "full aggregate output\n",
          postToolUseResponse,
        },
      });
      expect(result.failures).toContain(
        `${CODEX_HOOK_REGISTRATIONS[2]!.id} lost the real tool_response`,
      );
    } finally {
      await test.close();
    }
  });

  it.each(["wrong command", "wrong bytes"])(
    "rejects native file proof evidence with %s without returning filled content",
    async (failure) => {
      const test = fixture();
      try {
        if (failure === "wrong command")
          Reflect.set(test.nativeFileRead, "argv", ["bash", "-c", "cat /workspace/other.txt"]);
        else
          Reflect.set(test.nativeFileRead, "stdout", new TextEncoder().encode("changed output\n"));
        const result = await verifyCodexHooks(test.input);
        expect(result.ok).toBe(false);
        expect(result.failures).toContain(
          failure === "wrong command"
            ? "Codex did not execute the expected native cat command"
            : "Codex native cat output did not match the filled file bytes",
        );
        expect(JSON.stringify(result)).not.toContain(standardProofFilledWrite());
      } finally {
        await test.close();
      }
    },
  );

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

  it("rejects a post-tool event moved ahead of its matching pre-tool event", async () => {
    const test = fixture();
    try {
      const originals = test.invocations.filter((record) =>
        CODEX_HOOK_REGISTRATIONS.some((registration) => registration.id === record.id),
      );
      const reordered = [originals[0]!, originals.at(-1)!, ...originals.slice(1, -1)];
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

  it("keeps raw command diagnostics private until the public record boundary", async () => {
    const test = fixture();
    const rawSecret = STANDARD_PROOF_NAMED_SECRET.value;
    try {
      const pre = test.invocations.find((record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id)!;
      pre.stderr = `${rawSecret}\n`;
      const privateResult = await verifyCodexHooks(test.input);
      expect(privateResult.ok).toBe(false);
      expect(privateResult.failures).toContain(
        `${pre.id} did not scrub the command environment from stderr`,
      );
      expect(JSON.stringify(privateResult)).toContain(rawSecret);
      const publicResult = scrubStandardProofRecord(privateResult);
      expect(JSON.stringify(publicResult)).not.toContain(rawSecret);
      expect(publicResult).toMatchObject({
        ok: false,
        recordBoundary: { unexpectedRawSecret: true },
      });
    } finally {
      await test.close();
    }
  });

  it("fails closed when a raw fixture value reaches the canonical hook capture", async () => {
    const test = fixture();
    const rawSecret = STANDARD_PROOF_NAMED_SECRET.value;
    try {
      const rawCaptureRecords = test.invocations.filter((record) => {
        if (
          record.event !== "pre-tool-use" ||
          (record.id !== CODEX_HOOK_REGISTRATIONS[1]!.id &&
            record.id !== CODEX_STANDARD_HOOK_REGISTRATIONS[0]!.id)
        )
          return false;
        const input = record.input;
        return (
          typeof input === "object" &&
          input !== null &&
          Reflect.get(input, "tool_use_id") === "call-1069-exec"
        );
      });
      if (rawCaptureRecords.length !== 2)
        throw new Error("Expected both native and standard PreToolUse records");
      for (const record of rawCaptureRecords) {
        if (typeof record.input !== "object" || record.input === null)
          throw new Error("Expected a PreToolUse payload object");
        Reflect.set(record.input, "proofLogDiagnostic", rawSecret);
      }
      const nativePreToolUse = test.invocations.filter(
        (record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id,
      );
      const captureBytes = new TextEncoder().encode(
        nativePreToolUse.map((record) => `${JSON.stringify(record.input)}\n`).join(""),
      );
      const captureFd = test.input.filesystem.open(
        PRE_TOOL_USE_CAPTURE_PATH,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        0o644,
      );
      try {
        const written = test.input.filesystem.write(captureFd, captureBytes, null);
        if (written !== captureBytes.byteLength)
          throw new Error("Canonical hook capture write ended early");
      } finally {
        test.input.filesystem.close(captureFd);
      }
      const readFd = test.input.filesystem.open(
        PRE_TOOL_USE_CAPTURE_PATH,
        KernelOpenFlags.O_RDONLY,
      );
      let canonicalCapture: string;
      try {
        const bytes = new Uint8Array(Number(test.input.filesystem.fstat(readFd).size));
        const read = test.input.filesystem.read(readFd, bytes, null);
        if (read !== bytes.byteLength) throw new Error("Canonical hook capture read ended early");
        canonicalCapture = new TextDecoder().decode(bytes);
      } finally {
        test.input.filesystem.close(readFd);
      }
      expect(canonicalCapture).toContain(rawSecret);

      const privateResult = await verifyCodexHooks(test.input);
      expect(privateResult.ok).toBe(true);

      const publicResult = scrubStandardProofRecord(privateResult);
      expect(publicResult).toMatchObject({
        ok: false,
        recordBoundary: { unexpectedRawSecret: true },
      });
      expect(JSON.stringify(publicResult)).not.toContain(rawSecret);
      expect(JSON.stringify(publicResult)).toContain("{{secret:API_TOKEN}}");
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
