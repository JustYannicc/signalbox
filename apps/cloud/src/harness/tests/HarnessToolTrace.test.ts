import { describe, expect, it } from "vite-plus/test";
import { createHarnessToolTraceLedger } from "../HarnessToolTrace.ts";

type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

function hook(
  event: HookEvent,
  toolName: string,
  id: string,
  command?: string,
  cwd = "/work",
  extra: Record<string, unknown> = {},
) {
  return {
    hook_event_name: event,
    session_id: "session",
    transcript_path: "/work/transcript.jsonl",
    cwd,
    tool_name: toolName,
    tool_use_id: id,
    tool_input: command === undefined ? {} : { command },
    ...extra,
  };
}

function spawn(
  childId: string,
  processKey: string,
  script: string,
  cwd = "/work",
  executable = "/bin/bash",
  argv: readonly string[] = ["bash", "-c", script],
) {
  return {
    childId,
    processKey,
    executable,
    argv,
    cwd,
    raw: { executable, argv, cwd },
  };
}

function terminal(
  pre: ReturnType<typeof hook>,
  event: "PostToolUse" | "PostToolUseFailure",
  extra: Record<string, unknown> = {},
) {
  return { ...pre, hook_event_name: event, ...extra };
}

describe("harness SDK hook and child trace ledger", () => {
  it("joins overlapping different Bash commands after short child lifecycles and retains raw results", () => {
    const ledger = createHarnessToolTraceLedger();
    const firstPre = hook("PreToolUse", "Bash", "call-a", "printf A");
    const secondPre = hook("PreToolUse", "Bash", "call-b", "printf B");
    const success = { stdout: "A", stderr: "", exitCode: 0 };
    const failure = { message: "original tool failure", cause: null };
    const firstPost = terminal(firstPre, "PostToolUse", { tool_response: success });
    const secondPost = terminal(secondPre, "PostToolUseFailure", {
      error: failure,
      is_interrupt: false,
    });

    ledger.observeHook("host-a", "PreToolUse", firstPre, "call-a");
    ledger.observeHook("host-a", "PreToolUse", secondPre, "call-b");
    ledger.observeChildSpawn(spawn("child-a", "host-a", "printf A"));
    ledger.observeChildSpawn(spawn("child-b", "host-a", "printf B"));
    ledger.observeChildClose("child-a", { closeArgs: [0, null] });
    ledger.observeChildClose("child-b", { closeArgs: [null, "SIGTERM"] });
    ledger.observeHook("host-a", "PostToolUse", firstPost, "call-a");
    ledger.observeHook("host-a", "PostToolUseFailure", secondPost, "call-b");

    const result = ledger.finalize([
      { id: "call-a", name: "Bash", processKey: "host-a", sessionId: "session" },
      { id: "call-b", name: "Bash", processKey: "host-a", sessionId: "session" },
    ]);

    expect(result.verdicts.map((row) => row.kind)).toEqual(["joined", "joined"]);
    expect(result.verdicts[0]).toMatchObject({
      kind: "joined",
      hooks: { pre: { raw: firstPre }, terminal: { raw: firstPost, event: "PostToolUse" } },
      children: [{ childId: "child-a", closeReceipts: [{ raw: { closeArgs: [0, null] } }] }],
    });
    expect(result.verdicts[1]).toMatchObject({
      kind: "joined",
      hooks: {
        pre: { raw: secondPre },
        terminal: { raw: secondPost, event: "PostToolUseFailure" },
      },
      children: [
        { childId: "child-b", closeReceipts: [{ raw: { closeArgs: [null, "SIGTERM"] } }] },
      ],
    });
    expect(result.verdicts[0]?.kind === "joined" && result.verdicts[0].hooks.terminal.raw).toBe(
      firstPost,
    );
    expect(result.verdicts[1]?.kind === "joined" && result.verdicts[1].hooks.terminal.raw).toBe(
      secondPost,
    );
    expect(Object.hasOwn(secondPost, "tool_response")).toBe(false);
    expect(Reflect.get(secondPost, "error")).toBe(failure);
    expect(result.coverage).toMatchObject({
      toolCalls: { denominator: 2, joined: 2, noChild: 0, gaps: 0 },
      hookPairs: { denominator: 2, complete: 2, gaps: 0 },
      childProcesses: { denominator: 2, associated: 2, orphaned: 0, lifecycleIncomplete: 0 },
    });
  });

  it("gaps both identical overlapping windows when either window could own either spawn", () => {
    const ledger = createHarnessToolTraceLedger();
    const firstPre = hook("PreToolUse", "Bash", "call-a", "printf same");
    const secondPre = hook("PreToolUse", "Bash", "call-b", "printf same");
    ledger.observeHook("host", "PreToolUse", firstPre, "call-a");
    ledger.observeHook("host", "PreToolUse", secondPre, "call-b");
    ledger.observeChildSpawn(spawn("child-1", "host", "printf same"));
    ledger.observeChildSpawn(spawn("child-2", "host", "printf same"));
    ledger.observeChildClose("child-1", { closeArgs: [0, null] });
    ledger.observeChildClose("child-2", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(firstPre, "PostToolUse"), "call-a");
    ledger.observeHook("host", "PostToolUse", terminal(secondPre, "PostToolUse"), "call-b");

    const result = ledger.finalize([
      { id: "call-a", name: "Bash" },
      { id: "call-b", name: "Bash" },
    ]);

    expect(result.verdicts.map((row) => row.kind)).toEqual(["gap", "gap"]);
    expect(result.verdicts.map((row) => row.kind === "gap" && row.reasons)).toEqual([
      ["ambiguous-multiple-shell-children"],
      ["ambiguous-multiple-shell-children"],
    ]);
    expect(result.verdicts.every((row) => row.kind === "gap" && row.children.length === 0)).toBe(
      true,
    );
    expect(result.coverage.toolCalls).toEqual({ denominator: 2, joined: 0, noChild: 0, gaps: 2 });
    expect(result.coverage.childProcesses).toMatchObject({
      denominator: 2,
      associated: 0,
      orphaned: 2,
    });
    expect(result.gaps.filter((gap) => gap.scope === "child").map((gap) => gap.reason)).toEqual([
      "unattributed-or-ambiguous-child",
      "unattributed-or-ambiguous-child",
    ]);
  });

  it("does not assign a shared child to the narrower of two identical overlapping windows", () => {
    const ledger = createHarnessToolTraceLedger();
    const a = hook("PreToolUse", "Bash", "a", "same");
    const b = hook("PreToolUse", "Bash", "b", "same");
    ledger.observeHook("host", "PreToolUse", a, "a");
    ledger.observeChildSpawn(spawn("first", "host", "same"));
    ledger.observeHook("host", "PreToolUse", b, "b");
    ledger.observeChildSpawn(spawn("shared", "host", "same"));
    ledger.observeChildClose("first", { args: [0, null] });
    ledger.observeChildClose("shared", { args: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(a, "PostToolUse"), "a");
    ledger.observeHook("host", "PostToolUse", terminal(b, "PostToolUse"), "b");
    const result = ledger.finalize([
      { id: "a", name: "Bash" },
      { id: "b", name: "Bash" },
    ]);
    expect(result.verdicts.map((row) => row.kind)).toEqual(["gap", "gap"]);
    expect(result.coverage.toolCalls).toEqual({ denominator: 2, joined: 0, noChild: 0, gaps: 2 });
    expect(result.coverage.childProcesses.associated).toBe(0);
  });

  it("counts duplicate spawn identity as a tool coverage gap", () => {
    const ledger = createHarnessToolTraceLedger();
    const pre = hook("PreToolUse", "Bash", "call", "same");
    ledger.observeHook("host", "PreToolUse", pre, "call");
    const child = spawn("duplicate", "host", "same");
    ledger.observeChildSpawn(child);
    ledger.observeChildSpawn(child);
    ledger.observeChildClose("duplicate", { args: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre, "PostToolUse"), "call");
    const result = ledger.finalize([{ id: "call", name: "Bash" }]);
    expect(result.verdicts[0]).toMatchObject({ kind: "gap", reasons: ["duplicate-child-id"] });
    expect(result.coverage.toolCalls.gaps).toBe(1);
    expect(result.coverage.childProcesses.associated).toBe(0);
  });

  it("keeps same-ID calls separate by process key and session, and requires exact command, cwd, and shell argv", () => {
    const ledger = createHarnessToolTraceLedger();
    for (const [processKey, childId] of [
      ["host-a", "child-a"],
      ["host-b", "child-b"],
    ] as const) {
      const pre = hook("PreToolUse", "Bash", "same-id", "echo exact");
      ledger.observeHook(processKey, "PreToolUse", pre, "same-id");
      ledger.observeChildSpawn(spawn(childId, processKey, "echo exact"));
      ledger.observeChildClose(childId, { closeArgs: [0, null] });
      ledger.observeHook(processKey, "PostToolUse", terminal(pre, "PostToolUse"), "same-id");
    }

    const cwdPre = hook("PreToolUse", "Bash", "cwd", "echo exact", "/work");
    ledger.observeHook("host-c", "PreToolUse", cwdPre, "cwd");
    ledger.observeChildSpawn(spawn("wrong-cwd", "host-c", "echo exact", "/work/child"));
    ledger.observeChildClose("wrong-cwd", { closeArgs: [0, null] });
    ledger.observeHook("host-c", "PostToolUse", terminal(cwdPre, "PostToolUse"), "cwd");

    const wrapperPre = hook("PreToolUse", "Bash", "wrapper", "echo exact");
    ledger.observeHook("host-d", "PreToolUse", wrapperPre, "wrapper");
    ledger.observeChildSpawn(
      spawn("wrapped", "host-d", "node -e 'echo exact'", "/work", "/bin/bash", [
        "bash",
        "-c",
        "node -e 'echo exact'",
      ]),
    );
    ledger.observeChildClose("wrapped", { closeArgs: [0, null] });
    ledger.observeHook("host-d", "PostToolUse", terminal(wrapperPre, "PostToolUse"), "wrapper");

    const result = ledger.finalize([
      { id: "same-id", name: "Bash", processKey: "host-a", sessionId: "session" },
      { id: "same-id", name: "Bash", processKey: "host-b", sessionId: "session" },
      { id: "cwd", name: "Bash", processKey: "host-c" },
      { id: "wrapper", name: "Bash", processKey: "host-d" },
    ]);

    expect(result.verdicts.map((row) => row.kind)).toEqual(["joined", "joined", "gap", "gap"]);
    expect(result.verdicts[2]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
    expect(result.verdicts[3]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
    expect(result.coverage.toolCalls).toEqual({ denominator: 4, joined: 2, noChild: 0, gaps: 2 });
  });

  it("emits explicit no-child only for complete non-Bash windows without unattributed children", () => {
    const ledger = createHarnessToolTraceLedger();
    const readPre = hook("PreToolUse", "Read", "read-1");
    ledger.observeHook("host", "PreToolUse", readPre, "read-1");

    const bashPre = hook("PreToolUse", "Bash", "bash-1", "printf owned");
    ledger.observeHook("host", "PreToolUse", bashPre, "bash-1");
    ledger.observeChildSpawn(spawn("owned-child", "host", "printf owned"));
    ledger.observeChildClose("owned-child", { closeArgs: [0, null] });
    ledger.observeHook(
      "host",
      "PostToolUse",
      terminal(readPre, "PostToolUse", { tool_response: "text" }),
      "read-1",
    );
    ledger.observeHook("host", "PostToolUse", terminal(bashPre, "PostToolUse"), "bash-1");

    const editPre = hook("PreToolUse", "Edit", "edit-1");
    ledger.observeHook("host", "PreToolUse", editPre, "edit-1");
    ledger.observeChildSpawn(spawn("unexpected-child", "host", "printf unrelated"));
    ledger.observeChildClose("unexpected-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(editPre, "PostToolUse"), "edit-1");

    const result = ledger.finalize([
      { id: "read-1", name: "Read", processKey: "host", sessionId: "session" },
      { id: "bash-1", name: "Bash", processKey: "host", sessionId: "session" },
      { id: "edit-1", name: "Edit", processKey: "host", sessionId: "session" },
    ]);

    expect(result.verdicts.map((row) => row.kind)).toEqual(["no-child", "joined", "gap"]);
    expect(result.verdicts[2]).toMatchObject({
      kind: "gap",
      reasons: ["unattributed-child-in-window"],
    });
  });

  it("counts missing and duplicate hook coverage, callback ID mismatches, and late orphan children", () => {
    const ledger = createHarnessToolTraceLedger();
    const duplicatePre = hook("PreToolUse", "Read", "duplicate");
    ledger.observeHook("host", "PreToolUse", duplicatePre, "different-callback-id");
    ledger.observeHook("host", "PreToolUse", { ...duplicatePre, tool_input: null }, "duplicate");
    const extraPost = terminal(duplicatePre, "PostToolUse", { tool_response: null });
    ledger.observeHook("host", "PostToolUse", extraPost, "duplicate");
    const mismatchPre = hook("PreToolUse", "Read", "callback-mismatch");
    ledger.observeHook("host", "PreToolUse", mismatchPre, "wrong-callback-id");
    ledger.observeHook(
      "host",
      "PostToolUse",
      terminal(mismatchPre, "PostToolUse", { tool_response: "read result" }),
      "callback-mismatch",
    );
    const lateSpawn = spawn("late-child", "host", "printf late");
    ledger.observeChildSpawn(lateSpawn);
    ledger.observeChildSpawn({ ...lateSpawn, raw: { duplicate: true } });
    ledger.observeChildClose("late-child", { closeArgs: [0, null] });
    ledger.observeChildClose("unknown-child", { closeArgs: [null, "SIGKILL"] });

    const result = ledger.finalize([
      { id: "missing", name: "Read", processKey: "host", sessionId: "session" },
      { id: "duplicate", name: "Read", processKey: "host", sessionId: "session" },
      { id: "callback-mismatch", name: "Read", processKey: "host", sessionId: "session" },
    ]);

    expect(result.verdicts[0]).toMatchObject({ kind: "gap", reasons: ["missing-pre-hook"] });
    expect(result.verdicts[1]).toMatchObject({
      kind: "gap",
      reasons: expect.arrayContaining(["duplicate-or-ambiguous-pre-hook"]),
    });
    expect(result.verdicts[2]).toMatchObject({
      kind: "gap",
      reasons: ["callback-tool-use-id-mismatch"],
    });
    const firstPre = result.hooks[0]!;
    const secondPre = result.hooks[1]!;
    expect(firstPre.fields.tool_input).toEqual({
      state: "present",
      value: duplicatePre.tool_input,
    });
    expect(secondPre.fields.tool_input).toEqual({ state: "present", value: null });
    expect(result.hooks[2]?.fields.cwd).toEqual({ state: "present", value: "/work" });
    expect(result.hooks[2]?.raw).toBe(extraPost);
    expect(result.childProcesses.get("late-child")?.closeReceipts[0]?.raw).toEqual({
      closeArgs: [0, null],
    });
    expect(result.childSpawnObservations.get("late-child")?.map((row) => row.raw)).toEqual([
      lateSpawn.raw,
      { duplicate: true },
    ]);
    expect(result.unattachedChildReceipts[0]?.raw).toEqual({ closeArgs: [null, "SIGKILL"] });
    expect(result.coverage.toolCalls).toEqual({ denominator: 3, joined: 0, noChild: 0, gaps: 3 });
    expect(result.coverage.childProcesses).toMatchObject({
      denominator: 1,
      associated: 0,
      orphaned: 1,
    });
    expect(result.coverage.hookPairs.duplicateEvents).toBe(1);
    expect(result.gaps.some((gap) => gap.scope === "child" && gap.reason === "orphan-child")).toBe(
      true,
    );
  });
});
