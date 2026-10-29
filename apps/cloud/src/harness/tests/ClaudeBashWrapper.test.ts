import { describe, expect, it } from "vite-plus/test";
import { createHarnessToolTraceLedger } from "../HarnessToolTrace.ts";
import {
  observedLedger,
  wrapperPrefix as prefix,
  wrapperSuffix as suffix,
} from "./toolTraceFixture.ts";

function singleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function doubleQuote(value: string) {
  let encoded = '"';
  for (const char of value) {
    if (char === "\\" || char === '"' || char === "$" || char === "`") encoded += "\\";
    encoded += char;
  }
  return `${encoded}"`;
}

function wrapper(command: string, quote: (value: string) => string = singleQuote) {
  return `${prefix}${quote(command)}${suffix}`;
}

function hook(id: string, command: string, cwd = "/work") {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_name: "Bash",
    tool_use_id: id,
    tool_input: { command },
    cwd,
  };
}

function terminal(pre: ReturnType<typeof hook>) {
  return { ...pre, hook_event_name: "PostToolUse", tool_response: { stdout: "done" } };
}

function spawn(childId: string, processKey: string, command: string, cwd = "/work") {
  const script = wrapper(command);
  return {
    childId,
    processKey,
    executable: "/bin/bash",
    argv: ["/bin/bash", "-c", "-l", script],
    cwd,
    raw: { executable: "/bin/bash", argv: ["/bin/bash", "-c", "-l", script], cwd },
  };
}

function recordCall(
  ledger: ReturnType<typeof createHarnessToolTraceLedger>,
  id: string,
  command: string,
  childId: string,
  processKey = "host",
  hookCwd = "/work",
  childCwd = "/work",
) {
  const pre = hook(id, command, hookCwd);
  ledger.observeHook(processKey, "PreToolUse", pre, id);
  ledger.observeChildSpawn(spawn(childId, processKey, command, childCwd));
  ledger.observeChildClose(childId, { closeArgs: [0, null] });
  ledger.observeHook(processKey, "PostToolUse", terminal(pre), id);
}

const rootMapping = {
  id: "fixture-root-to-work",
  sourceRepositoryPrivate: "/private/repo",
  cwdPrivate: "/private/repo",
  cwdMapped: false,
};

describe("Claude Bash wrapper extraction", () => {
  it("decodes the observed template, compares the complete command, and records mapping provenance", () => {
    const command = `printf '%s' "quoted $HOME \`command\``;
    const ledger = observedLedger({ pathMapping: rootMapping });
    recordCall(ledger, "call", command, "child", "host", "/private/repo", "/work");
    const result = ledger.finalize([
      { id: "call", name: "Bash", processKey: "host", sessionId: "session" },
    ]);

    expect(result.verdicts[0]).toMatchObject({
      kind: "joined",
      provenance: {
        templateId: "claude-bash-shopt-eval-pwd-v1",
        operandSpan: {
          argvIndex: 3,
          start: prefix.length,
          end: expect.any(Number),
          unit: "utf16-code-units",
        },
        pathMappingId: rootMapping.id,
      },
      children: [{ argv: ["/bin/bash", "-c", "-l", wrapper(command)] }],
    });
    expect(
      result.childSpawnObservations.find((row) => row.childId === "child")?.observations?.[0]?.argv,
    ).toEqual(["/bin/bash", "-c", "-l", wrapper(command)]);
  });

  it("decodes POSIX double quotes and leaves literal eval text inside the command intact", () => {
    const command = `printf '%s' 'eval is data' "$HOME"`;
    const ledger = observedLedger();
    const pre = hook("double", command);
    ledger.observeHook("host", "PreToolUse", pre, "double");
    const script = wrapper(command, doubleQuote);
    ledger.observeChildSpawn({
      childId: "double-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", script],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", script] },
    });
    ledger.observeChildClose("double-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre), "double");

    const result = ledger.finalize([{ id: "double", name: "Bash" }]);
    expect(result.verdicts[0]?.kind).toBe("joined");
    expect(
      result.verdicts[0]?.kind === "joined" && result.verdicts[0].provenance.operandSpan,
    ).toMatchObject({
      argvIndex: 3,
      start: prefix.length,
      unit: "utf16-code-units",
    });
  });

  it("does not mistake an eval inside the decoded command for the outer operand", () => {
    const actualCommand = "eval 'printf inner'";
    const ledger = observedLedger();
    const pre = hook("inner", "printf inner");
    ledger.observeHook("host", "PreToolUse", pre, "inner");
    const actualWrapper = wrapper(actualCommand);
    const falseChild = {
      ...spawn("false-child", "host", "printf inner"),
      argv: ["/bin/bash", "-c", "-l", actualWrapper],
      raw: { argv: ["/bin/bash", "-c", "-l", actualWrapper] },
    };
    ledger.observeChildSpawn(falseChild);
    ledger.observeChildClose("false-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre), "inner");
    const result = ledger.finalize([
      { id: "inner", name: "Bash", processKey: "host", sessionId: "session" },
    ]);

    expect(result.verdicts[0]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
  });

  it("gaps command mismatches, trailing-newline changes, unsupported expansions, and malformed wrappers", () => {
    const ledger = observedLedger();
    const mismatched = hook("mismatch", "printf expected");
    ledger.observeHook("host", "PreToolUse", mismatched, "mismatch");
    const commandWrapper = wrapper("printf different");
    ledger.observeChildSpawn({
      childId: "mismatch-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", commandWrapper],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", commandWrapper] },
    });
    ledger.observeChildClose("mismatch-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(mismatched), "mismatch");

    const newlinePre = hook("newline", "printf exact");
    ledger.observeHook("host", "PreToolUse", newlinePre, "newline");
    const newlineScript = wrapper("printf exact\n");
    ledger.observeChildSpawn({
      childId: "newline-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", newlineScript],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", newlineScript] },
    });
    ledger.observeChildClose("newline-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(newlinePre), "newline");

    const ansiPre = hook("ansi", "printf ansi");
    ledger.observeHook("host", "PreToolUse", ansiPre, "ansi");
    const ansiScript = `${prefix}$'printf ansi'${suffix}`;
    ledger.observeChildSpawn({
      childId: "ansi-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", ansiScript],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", ansiScript] },
    });
    ledger.observeChildClose("ansi-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(ansiPre), "ansi");

    const malformedPre = hook("malformed", "printf malformed");
    ledger.observeHook("host", "PreToolUse", malformedPre, "malformed");
    const malformedScript = `${prefix}'unterminated${suffix}`;
    ledger.observeChildSpawn({
      childId: "malformed-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", malformedScript],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", malformedScript] },
    });
    ledger.observeChildClose("malformed-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(malformedPre), "malformed");

    const extraEvalPre = hook("extra-eval", "printf extra");
    ledger.observeHook("host", "PreToolUse", extraEvalPre, "extra-eval");
    const extraEvalScript = `${prefix}${singleQuote("printf extra")} && eval 'printf extra'${suffix}`;
    ledger.observeChildSpawn({
      childId: "extra-eval-child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", extraEvalScript],
      cwd: "/work",
      raw: { argv: ["/bin/bash", "-c", "-l", extraEvalScript] },
    });
    ledger.observeChildClose("extra-eval-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(extraEvalPre), "extra-eval");

    const result = ledger.finalize([
      { id: "mismatch", name: "Bash", processKey: "host", sessionId: "session" },
      { id: "newline", name: "Bash", processKey: "host", sessionId: "session" },
      { id: "ansi", name: "Bash", processKey: "host", sessionId: "session" },
      { id: "malformed", name: "Bash", processKey: "host", sessionId: "session" },
      { id: "extra-eval", name: "Bash", processKey: "host", sessionId: "session" },
    ]);

    expect(result.verdicts[0]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
    expect(result.verdicts[1]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
    expect(result.verdicts[2]).toMatchObject({
      kind: "gap",
      reasons: ["unsupported-shell-wrapper:unsupported-ansi-c-quote"],
    });
    expect(result.verdicts[3]).toMatchObject({
      kind: "gap",
      reasons: ["unsupported-shell-wrapper:unparseable-shell-quote"],
    });
    expect(result.verdicts[4]).toMatchObject({
      kind: "gap",
      reasons: ["unsupported-shell-wrapper:unsupported-wrapper-suffix"],
    });
  });

  it("compares Unicode command bytes without normalization", () => {
    const ledger = observedLedger();
    const composed = "printf café";
    const decomposed = "printf cafe\u0301";
    const pre = hook("unicode", composed);
    ledger.observeHook("host", "PreToolUse", pre, "unicode");
    ledger.observeChildSpawn(spawn("unicode-child", "host", decomposed));
    ledger.observeChildClose("unicode-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre), "unicode");

    const result = ledger.finalize([{ id: "unicode", name: "Bash" }]);
    expect(result.verdicts[0]).toMatchObject({
      kind: "gap",
      reasons: ["no-exact-shell-child-match"],
    });
  });

  it("gaps identical overlapping wrapper calls instead of guessing ownership", () => {
    const ledger = observedLedger({ pathMapping: rootMapping });
    const command = "printf overlap";
    const first = hook("first", command, "/private/repo");
    const second = hook("second", command, "/private/repo");
    ledger.observeHook("host", "PreToolUse", first, "first");
    ledger.observeHook("host", "PreToolUse", second, "second");
    ledger.observeChildSpawn(spawn("child-1", "host", command, "/work"));
    ledger.observeChildSpawn(spawn("child-2", "host", command, "/work"));
    ledger.observeChildClose("child-1", { closeArgs: [0, null] });
    ledger.observeChildClose("child-2", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(first), "first");
    ledger.observeHook("host", "PostToolUse", terminal(second), "second");

    const result = ledger.finalize([
      { id: "first", name: "Bash" },
      { id: "second", name: "Bash" },
    ]);
    expect(result.verdicts.map((row) => row.kind)).toEqual(["gap", "gap"]);
    expect(result.verdicts.map((row) => row.kind === "gap" && row.reasons)).toEqual([
      ["ambiguous-multiple-shell-children"],
      ["ambiguous-multiple-shell-children"],
    ]);
  });

  it("does not map cwd prefixes or suffixes", () => {
    const ledger = observedLedger({ pathMapping: rootMapping });
    const command = "printf cwd";
    const pre = hook("cwd", command, "/private/repo/subdir");
    ledger.observeHook("host", "PreToolUse", pre, "cwd");
    ledger.observeChildSpawn(spawn("cwd-child", "host", command, "/work/subdir"));
    ledger.observeChildClose("cwd-child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre), "cwd");

    const result = ledger.finalize([{ id: "cwd", name: "Bash" }]);
    expect(result.verdicts[0]).toMatchObject({ kind: "gap", reasons: ["cwd-mapping-mismatch"] });
  });

  it("rejects a wrapper with an unobserved argv0", () => {
    const ledger = observedLedger();
    const pre = hook("argv0", "printf exact");
    ledger.observeHook("host", "PreToolUse", pre, "argv0");
    const child = spawn("child", "host", "printf exact");
    ledger.observeChildSpawn({ ...child, argv: ["different-argv0", ...child.argv.slice(1)] });
    ledger.observeChildClose("child", { closeArgs: [0, null] });
    ledger.observeHook("host", "PostToolUse", terminal(pre), "argv0");
    expect(ledger.finalize([{ id: "argv0", name: "Bash" }]).verdicts[0]).toMatchObject({
      kind: "gap",
      reasons: ["unsupported-shell-wrapper:unsupported-wrapper-argv"],
    });
  });
});
