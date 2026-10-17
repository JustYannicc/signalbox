// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "vite-plus/test";

import { fillToolInput, secretFillHook } from "./RunnerSecretFill.ts";

const KEY = `sk-test-${crypto.randomUUID()}`;
const guarded = { values: new Map([["KEY", KEY]]), guarded: true };

describe("RunnerSecretFill", () => {
  it("preserves placeholders in commands and nested file edits, and leaves other tools alone", () => {
    expect(
      fillToolInput(
        "Bash",
        {
          command: 'curl -H "Authorization: Bearer {{secret:KEY}}" https://example.test',
          timeout: 5,
        },
        guarded,
      ),
    ).toEqual({ _tag: "untouched" });
    expect(
      fillToolInput(
        "MultiEdit",
        { file_path: ".env", edits: [{ old_string: "KEY={{secret:KEY}}", new_string: "KEY=" }] },
        guarded,
      ),
    ).toEqual({ _tag: "untouched" });
    expect(fillToolInput("mcp__signalbox__create_pr", { body: "{{secret:KEY}}" }, guarded)).toEqual(
      { _tag: "untouched" },
    );
    expect(fillToolInput("Write", { file_path: "a", content: "no secrets" }, guarded)).toEqual({
      _tag: "untouched",
    });
  });

  it("lets local tools keep an unknown placeholder literal", async () => {
    const [hook] = secretFillHook(() => ({ ...guarded, guarded: false })).hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "/w" } as const;
    const toolInput = {
      file_path: "docs/notes.md",
      content: "Use {{secret:NOT_CONFIGURED}} here.",
    };
    const output = await hook!(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: toolInput,
        tool_use_id: "toolu_3",
      },
      "toolu_3",
      { signal },
    );

    expect(output).toEqual({});
    expect(toolInput.content).toBe("Use {{secret:NOT_CONFIGURED}} here.");
    expect(JSON.stringify({ toolInput, output })).not.toContain(KEY);
  });

  it("keeps a valid placeholder literal in Claude Code's PreToolUse input", async () => {
    const [hook] = secretFillHook(() => guarded).hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "/w" } as const;
    const toolInput = { file_path: ".env", content: "KEY={{secret:KEY}}\n" };
    const event = {
      ...base,
      hook_event_name: "PreToolUse" as const,
      tool_name: "Write",
      tool_input: toolInput,
      tool_use_id: "toolu_1",
    };

    const filled = await hook!(event, "toolu_1", { signal });
    expect(filled).toEqual({});
    expect(event.tool_input).toEqual({ file_path: ".env", content: "KEY={{secret:KEY}}\n" });
    expect(JSON.stringify({ event, filled })).not.toContain(KEY);
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
    expect(denied).toEqual({});
  });
});
