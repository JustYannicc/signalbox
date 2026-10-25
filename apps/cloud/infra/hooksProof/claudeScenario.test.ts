import { describe, expect, it } from "@effect/vitest";
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_ROUTES,
  CLAUDE_TOOL_FILE,
  CLAUDE_TOOL_READ_COMMAND,
  claudeToolScript,
  claudeToolScripts,
  createClaudeHookScenario,
  inspectClaudeNativeFileRead,
} from "./claudeScenario.ts";
import { standardProofFilledWrite, STANDARD_PROOF_WRITE } from "./standardProofAdapter.ts";

describe("Claude official hook proof settings", () => {
  it("registers command, Signalbox callback and generated script routes for each event", () => {
    const scenario = createClaudeHookScenario();
    expect(scenario.configuredHooks).toHaveLength(
      CLAUDE_HOOK_EVENTS.length * CLAUDE_HOOK_ROUTES.length,
    );
    expect(scenario.registrations.size).toBe(scenario.configuredHooks.length);

    for (const { event, officialName } of CLAUDE_HOOK_EVENTS) {
      const configured = scenario.configuredHooks.filter((hook) => hook.event === event);
      const settings = scenario.settings.hooks[officialName];
      expect(configured).toHaveLength(CLAUDE_HOOK_ROUTES.length);
      expect(settings?.[0]?.hooks).toHaveLength(CLAUDE_HOOK_ROUTES.length);
      for (const { id } of configured) {
        const registration = scenario.registrations.get(id);
        expect(registration?.event).toBe(event);
        expect(settings?.[0]?.hooks).toContainEqual({
          type: "command",
          command: "/usr/bin/signalbox-hook " + id,
        });
      }
    }
  });

  it("runs canonical Write and Read followed by a native Bash cat command", () => {
    expect(claudeToolScripts()).toEqual([
      {
        name: "Write",
        input: { file_path: CLAUDE_TOOL_FILE, content: STANDARD_PROOF_WRITE },
      },
      { name: "Read", input: { file_path: CLAUDE_TOOL_FILE } },
      { name: "Bash", input: { command: CLAUDE_TOOL_READ_COMMAND } },
    ]);
    expect(claudeToolScript()).toEqual(claudeToolScripts()[0]);
  });

  it("verifies raw cat bytes without including the filled values in proof evidence", () => {
    const evidence = {
      executable: "bash",
      argv: ["bash", "-lc", CLAUDE_TOOL_READ_COMMAND],
      stdout: new TextEncoder().encode(standardProofFilledWrite()),
    };
    const verified = inspectClaudeNativeFileRead(evidence);
    expect(verified).toMatchObject({
      commandMatched: true,
      outputBytes: new TextEncoder().encode(standardProofFilledWrite()).byteLength,
      matchesFilledBytes: true,
    });
    expect(JSON.stringify(verified)).not.toContain(standardProofFilledWrite());
    expect(
      inspectClaudeNativeFileRead({ ...evidence, stdout: new TextEncoder().encode("changed") })
        .matchesFilledBytes,
    ).toBe(false);
    expect(
      inspectClaudeNativeFileRead({ ...evidence, argv: ["bash", "-lc", "cat /work/elsewhere"] })
        .commandMatched,
    ).toBe(false);
  });

  it("recognizes the pinned native shell wrapper and rejects lookalike commands", () => {
    const script =
      "source /home/claude/.claude/shell-snapshots/snapshot-bash-1792422677909-2sl7xr.sh 2>/dev/null || true && " +
      "shopt -u extglob 2>/dev/null || true && " +
      "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && " +
      "eval 'cat /work/official-write.txt' < /dev/null && pwd -P >| /tmp/claude-e68c-cwd";
    const evidence = {
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", script],
      stdout: new TextEncoder().encode(standardProofFilledWrite()),
    };
    expect(inspectClaudeNativeFileRead(evidence)).toMatchObject({
      commandMatched: true,
      matchesFilledBytes: true,
    });
    const withoutSnapshot = script.slice(script.indexOf("shopt -u extglob"));
    expect(
      inspectClaudeNativeFileRead({
        ...evidence,
        argv: ["/bin/bash", "-c", "-l", withoutSnapshot],
      }).commandMatched,
    ).toBe(true);
    expect(
      inspectClaudeNativeFileRead({ ...evidence, argv: ["/bin/bash", "-c", withoutSnapshot] })
        .commandMatched,
    ).toBe(false);
    for (const changed of [
      script.replace(
        "eval 'cat /work/official-write.txt'",
        "printf '%s' 'cat /work/official-write.txt'",
      ),
      script.replace(
        "eval 'cat /work/official-write.txt'",
        "eval 'cat /work/official-write.txt; printf extra'",
      ),
      script.replace("/work/official-write.txt", "/work/elsewhere"),
      `${script}; printf extra`,
      `printf '%s' ${JSON.stringify(script)}`,
    ]) {
      expect(
        inspectClaudeNativeFileRead({ ...evidence, argv: ["/bin/bash", "-c", changed] })
          .commandMatched,
      ).toBe(false);
    }
    expect(
      inspectClaudeNativeFileRead({ ...evidence, argv: ["/bin/bash", "-c", script, "extra"] })
        .commandMatched,
    ).toBe(false);
    expect(inspectClaudeNativeFileRead({ ...evidence, executable: "/bin/sh" }).commandMatched).toBe(
      false,
    );
  });
});
