// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "vite-plus/test";

import { fillToolInput, secretFillHook } from "./RunnerSecretFill.ts";

const KEY = `sk-test-${crypto.randomUUID()}`;
const guarded = { values: new Map([["KEY", KEY]]), guarded: true };

describe("RunnerSecretFill", () => {
  it("fills commands and file writes, every field, and leaves other tools alone", () => {
    expect(
      fillToolInput(
        "Bash",
        {
          command: 'curl -H "Authorization: Bearer {{secret:KEY}}" https://example.test',
          timeout: 5,
        },
        guarded,
      ),
    ).toEqual({
      _tag: "filled",
      input: { command: `curl -H "Authorization: Bearer ${KEY}" https://example.test`, timeout: 5 },
    });
    expect(
      fillToolInput(
        "MultiEdit",
        { file_path: ".env", edits: [{ old_string: "KEY={{secret:KEY}}", new_string: "KEY=" }] },
        guarded,
      ),
    ).toEqual({
      _tag: "filled",
      input: { file_path: ".env", edits: [{ old_string: `KEY=${KEY}`, new_string: "KEY=" }] },
    });
    expect(fillToolInput("mcp__signalbox__create_pr", { body: "{{secret:KEY}}" }, guarded)).toEqual(
      { _tag: "untouched" },
    );
    expect(fillToolInput("Write", { file_path: "a", content: "no secrets" }, guarded)).toEqual({
      _tag: "untouched",
    });
  });

  it("refuses a name the thread has no secret for, and any fill on an unguarded machine", () => {
    expect(fillToolInput("Write", { content: "{{secret:NOPE}}" }, guarded)).toEqual({
      _tag: "refused",
      reason: "This thread has no secret called NOPE. It has: KEY.",
    });
    const refused = fillToolInput(
      "Bash",
      { command: "echo {{secret:KEY}}" },
      { ...guarded, guarded: false },
    );
    expect(refused._tag).toBe("refused");
    expect(JSON.stringify(refused)).not.toContain(KEY);
  });

  it("answers Claude Code's PreToolUse hook with the filled input or the refusal", async () => {
    const [hook] = secretFillHook(() => guarded).hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "/w" } as const;

    const filled = await hook!(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "KEY={{secret:KEY}}\n" },
        tool_use_id: "toolu_1",
      },
      "toolu_1",
      { signal },
    );
    expect(filled).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { file_path: ".env", content: `KEY=${KEY}\n` },
      },
    });
    const denied = await hook!(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo {{secret:OTHER}}" },
        tool_use_id: "toolu_2",
      },
      "toolu_2",
      { signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});
