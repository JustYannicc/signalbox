import { describe, expect, it } from "@effect/vitest";

import type { MockToolResult } from "./mockMessages.ts";
import {
  SCENARIO_EXPECTED_FILES,
  SCENARIO_SEED_FILES,
  TOOL_SCENARIO,
  type ToolScenarioInput,
  verifyToolScenario,
} from "./toolScenario.ts";

function observations(): ToolScenarioInput {
  const content = [
    [{ type: "text", text: "1 initial line\n2 needle-before" }],
    "",
    "",
    "/work/source.txt:2:needle-after",
    "/work/new.txt\n/work/source.txt",
    "shell-proof\n",
  ];
  return {
    stdout: `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
    mockComplete: true,
    toolResults: TOOL_SCENARIO.map((tool, index) => ({
      name: tool.name,
      toolUseId: `toolu_mock_${index + 1}`,
      content: content[index],
      is_error: false,
      raw: { type: "tool_result", content: content[index] },
    })),
    actualFiles: { ...SCENARIO_EXPECTED_FILES },
    committedFiles: Object.fromEntries(
      Object.entries(SCENARIO_EXPECTED_FILES).map(([path, text]) => [
        path,
        new TextEncoder().encode(text),
      ]),
    ),
    commitReceipt: { status: "ok", value: { commit: "proof-commit" } },
  };
}

function replaceResult(input: ToolScenarioInput, index: number, change: Partial<MockToolResult>) {
  return input.toolResults.map((result, position) =>
    position === index ? { ...result, ...change } : result,
  );
}

describe("Claude six-tool proof acceptance", () => {
  it("accepts complete observations with arbitrary Edit and Write success text", () => {
    const input = observations();
    expect(SCENARIO_SEED_FILES["/work/source.txt"]).toBe("initial line\nneedle-before\n");
    const evidence = verifyToolScenario(input);
    expect(evidence.ok).toBe(true);
    expect(evidence.errors).toEqual([]);
    expect(evidence.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "Bash",
    ]);
    expect(evidence.tools[0]?.raw).toEqual(input.toolResults[0]?.raw);
  });

  it("rejects missing and reordered actual results despite mock completion", () => {
    const input = observations();
    expect(verifyToolScenario({ ...input, toolResults: input.toolResults.slice(1) }).ok).toBe(
      false,
    );
    expect(verifyToolScenario({ ...input, toolResults: input.toolResults.toReversed() }).ok).toBe(
      false,
    );
  });

  it("rejects normalized and raw error results", () => {
    const input = observations();
    for (const change of [{ is_error: true }, { raw: { is_error: true } }]) {
      const evidence = verifyToolScenario({
        ...input,
        toolResults: replaceResult(input, 1, change),
      });
      expect(evidence.errors).toContain("Edit returned is_error");
      expect(evidence.tools[1]?.raw).toEqual(change.raw ?? input.toolResults[1]?.raw);
    }
  });

  it.each([0, 3, 4, 5])("requires observable output from tool result %i", (index) => {
    const input = observations();
    expect(
      verifyToolScenario({ ...input, toolResults: replaceResult(input, index, { content: "" }) })
        .ok,
    ).toBe(false);
  });

  it("requires both Glob matches", () => {
    const input = observations();
    expect(
      verifyToolScenario({
        ...input,
        toolResults: replaceResult(input, 4, { content: "source.txt" }),
      }).errors,
    ).toContain("Glob result is missing new.txt");
  });

  it("rejects an incomplete mock even with all results", () => {
    expect(verifyToolScenario({ ...observations(), mockComplete: false }).ok).toBe(false);
  });

  it.each([
    "",
    '{"type":"result","subtype":"success"}',
    '{"type":"result","subtype":"success","is_error":true}',
    '{"type":"result","subtype":"error","is_error":false}',
    '{"type":"result","subtype":"success","is_error":false}\n{"type":"assistant"}',
  ])("rejects invalid terminal result %s", (stdout) => {
    expect(verifyToolScenario({ ...observations(), stdout }).ok).toBe(false);
  });

  it.each(["runtime warning", "null", "[]", "42", "{}"])(
    "rejects non-event stdout before a valid result: %s",
    (line) => {
      const input = observations();
      expect(verifyToolScenario({ ...input, stdout: `${line}\n${input.stdout}` }).ok).toBe(false);
    },
  );

  it("rejects duplicate result events", () => {
    const input = observations();
    expect(verifyToolScenario({ ...input, stdout: input.stdout.repeat(2) }).ok).toBe(false);
  });

  it("requires SQLite writes and committed bytes independently", () => {
    const input = observations();
    const path = "/work/source.txt";
    for (const actual of [undefined, SCENARIO_SEED_FILES[path]])
      expect(
        verifyToolScenario({ ...input, actualFiles: { ...input.actualFiles, [path]: actual } }).ok,
      ).toBe(false);
    for (const bytes of [undefined, new TextEncoder().encode("initial line\nneedle-after\r\n")])
      expect(
        verifyToolScenario({ ...input, committedFiles: { ...input.committedFiles, [path]: bytes } })
          .ok,
      ).toBe(false);
  });

  it("rejects missing, failed, and empty commit receipts", () => {
    const input = observations();
    for (const commitReceipt of [
      undefined,
      { status: "error", error: { code: "IO_ERROR", message: "failed" } } as const,
      { status: "ok", value: { commit: "" } } as const,
    ])
      expect(verifyToolScenario({ ...input, commitReceipt }).ok).toBe(false);
  });
});
