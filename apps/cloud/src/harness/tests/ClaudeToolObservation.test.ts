import { describe, expect, it } from "@effect/vitest";
import {
  createClaudeToolObservation,
  type ClaudeToolHookInput,
  type ClaudeToolHookObservation,
} from "../ClaudeToolObservation.ts";

const input = (tool: string, id: string): ClaudeToolHookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "session",
  transcript_path: "/work/transcript",
  cwd: "/work",
  tool_name: tool,
  tool_use_id: id,
  tool_input: { command: "literal command", optional: null },
});

describe("Claude official tool observation", () => {
  it("observes every tool through SDK hooks and preserves payloads without returning decisions", async () => {
    const observed: ClaudeToolHookObservation[] = [];
    let time = 0;
    const observation = createClaudeToolObservation(
      (event) => {
        observed.push(event);
        return { hookSpecificOutput: { permissionDecision: "deny" } };
      },
      () => ++time,
    );
    const signal = new AbortController().signal;
    const tools = [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "Agent",
      "mcp__source__read",
    ];
    for (const [index, tool] of tools.entries()) {
      const payload = input(tool, String(index));
      const registration = observation.hooks.PreToolUse[0]!;
      expect(Object.hasOwn(registration, "matcher")).toBe(false);
      expect(await registration.hooks[0]!(payload, String(index), { signal })).toEqual({});
      expect(observed.at(-1)?.input).toBe(payload);
      expect(observed.at(-1)?.signal).toBe(signal);
      expect(observed.at(-1)?.toolUseId).toBe(String(index));
    }
    const post: ClaudeToolHookInput = {
      ...input("Bash", "done"),
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "full output", exitCode: null },
    };
    const failure: ClaudeToolHookInput = {
      ...input("Bash", "failed"),
      hook_event_name: "PostToolUseFailure",
      error: "original failure",
      is_interrupt: false,
    };
    expect(await observation.hooks.PostToolUse[0]!.hooks[0]!(post, "done", { signal })).toEqual({});
    expect(
      await observation.hooks.PostToolUseFailure[0]!.hooks[0]!(failure, "failed", { signal }),
    ).toEqual({});
    expect(observed.at(-2)?.input).toBe(post);
    expect(observed.at(-1)?.input).toBe(failure);
    await observation.drain();
    expect(observation.snapshot().failures).toEqual([]);
    expect(observation.snapshot().measurements).toHaveLength(tools.length + 2);
    expect(observation.snapshot().measurements.every((row) => row.durationMs === 1)).toBe(true);
  });

  it("keeps concurrent callback identity and measures their own durations", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let time = 10;
    const seen: string[] = [];
    const observation = createClaudeToolObservation(
      async (event) => {
        await (event.toolUseId === "first" ? first.promise : second.promise);
        seen.push(event.toolUseId!);
      },
      () => time,
    );
    const signal = new AbortController().signal;
    const callback = observation.hooks.PreToolUse[0]!.hooks[0]!;
    const a = callback(input("Bash", "first"), "first", { signal });
    time = 15;
    const b = callback(input("Bash", "second"), "second", { signal });
    expect(observation.snapshot().pending).toBe(2);
    time = 20;
    second.resolve();
    expect(await b).toEqual({});
    time = 30;
    first.resolve();
    expect(await a).toEqual({});
    await observation.drain();
    expect(seen).toEqual(["second", "first"]);
    expect(
      observation.snapshot().measurements.map((row) => [row.toolUseId, row.durationMs]),
    ).toEqual([
      ["second", 5],
      ["first", 20],
    ]);
    expect(observation.snapshot().pending).toBe(0);
  });

  it("records observer failures while its hook still returns an empty result", async () => {
    const error = new Error("capture failed", { cause: null });
    const observation = createClaudeToolObservation(() => {
      throw error;
    });
    const result = await observation.hooks.PreToolUse[0]!.hooks[0]!(input("Bash", "id"), "id", {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({});
    await observation.drain();
    expect(observation.snapshot().failures[0]?.error).toBe(error);
    expect(observation.snapshot().pending).toBe(0);
  });

  it("preserves existing hook decisions alongside observation", async () => {
    const observation = createClaudeToolObservation(() => undefined);
    const decision = { decision: "block" as const, reason: "existing policy" };
    const existing = {
      PreToolUse: [{ matcher: "Bash", hooks: [async () => decision] }],
      Stop: [{ hooks: [async () => ({})] }],
    };
    const merged = observation.withHooks(existing);
    const signal = new AbortController().signal;
    const payload = input("Bash", "id");
    expect(await merged.PreToolUse![0]!.hooks[0]!(payload, "id", { signal })).toBe(decision);
    expect(await merged.PreToolUse![1]!.hooks[0]!(payload, "id", { signal })).toEqual({});
    expect(merged.Stop).toBe(existing.Stop);
    expect(existing.PreToolUse).toHaveLength(1);
    expect(observation.snapshot().measurements).toHaveLength(1);
  });
});
