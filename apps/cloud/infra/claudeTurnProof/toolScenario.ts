import type {
  FileCommitReceipt,
  FilePersistenceResult,
} from "../../src/kernel/FilePersistencePorts.ts";
import type { MockToolResult, ScriptedMockTool } from "./mockMessages.ts";

export const SCENARIO_SEED_FILES = {
  "/work/source.txt": "initial line\nneedle-before\n",
};

export const SCENARIO_EXPECTED_FILES = {
  "/work/source.txt": "initial line\nneedle-after\n",
  "/work/new.txt": "written from Claude\n",
  "/work/shell.txt": "shell-proof\n",
};

export const TOOL_SCENARIO: readonly ScriptedMockTool[] = [
  { name: "Read", input: { file_path: "/work/source.txt" } },
  {
    name: "Edit",
    input: {
      file_path: "/work/source.txt",
      old_string: "needle-before",
      new_string: "needle-after",
    },
  },
  {
    name: "Write",
    input: { file_path: "/work/new.txt", content: "written from Claude\n" },
  },
  { name: "Grep", input: { pattern: "needle-after", path: "/work", output_mode: "content" } },
  { name: "Glob", input: { pattern: "*.txt", path: "/work" } },
  {
    name: "Bash",
    input: {
      command: "echo shell-proof > /work/shell.txt && cat /work/shell.txt",
      description: "Write and read the shell proof file",
    },
  },
];

export interface ToolScenarioInput {
  readonly stdout: string;
  readonly mockComplete: boolean;
  readonly toolResults: readonly MockToolResult[];
  /** Read through the same SQLite host that ran Claude's tools. */
  readonly actualFiles: Readonly<Record<string, string | undefined>>;
  /** Bytes from the persistence port's tree at the returned commit receipt. */
  readonly committedFiles: Readonly<Record<string, Uint8Array | undefined>>;
  readonly commitReceipt: FilePersistenceResult<FileCommitReceipt> | undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

/** Checks supplied runtime observations; it never fills gaps with scripted outcomes. */
export function verifyToolScenario(input: ToolScenarioInput) {
  const errors: string[] = [];
  const events: Record<string, unknown>[] = [];
  input.stdout.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      errors.push(`stdout line ${index + 1} is not JSON`);
      return;
    }
    if (!record(event) || typeof event.type !== "string") {
      errors.push(`stdout line ${index + 1} is not a Claude event`);
      return;
    }
    events.push(event);
  });
  const terminalResult = events.at(-1);
  if (
    terminalResult?.type !== "result" ||
    terminalResult.subtype !== "success" ||
    terminalResult.is_error !== false
  )
    errors.push("Claude did not end with a successful result event");
  if (events.filter((event) => event.type === "result").length !== 1)
    errors.push("stdout must contain exactly one result event");
  if (!input.mockComplete) errors.push("mock Messages script did not complete");
  if (input.toolResults.length !== TOOL_SCENARIO.length)
    errors.push(
      `expected ${TOOL_SCENARIO.length} actual tool results, got ${input.toolResults.length}`,
    );

  const tools = input.toolResults.map((result, index) => {
    const expected = TOOL_SCENARIO[index];
    const toolErrors: string[] = [];
    if (result.name !== expected?.name)
      toolErrors.push(`unexpected tool ${result.name} at ${index + 1}`);
    if (result.is_error || (record(result.raw) && result.raw.is_error === true))
      toolErrors.push(`${result.name} returned is_error`);
    const text = contentText(result.content);
    const requiredText =
      result.name === "Read"
        ? ["initial line"]
        : result.name === "Grep"
          ? ["needle-after"]
          : result.name === "Glob"
            ? ["new.txt", "source.txt"]
            : result.name === "Bash"
              ? ["shell-proof"]
              : [];
    for (const required of requiredText)
      if (!text.includes(required)) toolErrors.push(`${result.name} result is missing ${required}`);
    errors.push(...toolErrors);
    return { ...result, ok: toolErrors.length === 0, errors: toolErrors };
  });

  const files = Object.entries(SCENARIO_EXPECTED_FILES).map(([path, expected]) => {
    const sqliteMatches = input.actualFiles[path] === expected;
    const bytes = input.committedFiles[path];
    const expectedBytes = new TextEncoder().encode(expected);
    const committedMatches =
      bytes !== undefined &&
      bytes.byteLength === expectedBytes.byteLength &&
      bytes.every((byte, index) => byte === expectedBytes[index]);
    if (!sqliteMatches) errors.push(`SQLite file mismatch: ${path}`);
    if (!committedMatches) errors.push(`committed file bytes mismatch: ${path}`);
    return { path, sqliteMatches, committedMatches };
  });
  const receipt = input.commitReceipt;
  const committed = receipt?.status === "ok" && receipt.value.commit.trim().length > 0;
  if (!committed) errors.push("a successful persistence commit receipt is missing");
  return {
    ok: errors.length === 0,
    errors,
    mockComplete: input.mockComplete,
    terminalResult,
    tools,
    files,
    commitReceipt: receipt,
  };
}
