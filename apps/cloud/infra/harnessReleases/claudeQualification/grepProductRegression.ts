import { KERNEL_RIPGREP_ARTIFACT } from "../../../src/kernel/KernelRipgrepProgram.ts";

interface GrepRegressionInput {
  readonly runId: string;
  readonly requests: readonly Uint8Array[];
  readonly producerEvents: readonly unknown[];
  readonly kernelInvocations: readonly unknown[];
  readonly workRoute: string;
}

const path = "/workspace/claude-qualification.txt";

/** Consume captured public Messages requests and the actual command worker's producer pair. */
export function assertClaudeKernelGrep(input: GrepRegressionInput) {
  if (!Array.isArray(input.kernelInvocations))
    throw new Error("CLAUDE_GREP_PRODUCT_EVIDENCE_MISSING");
  const requests = input.requests.map((bytes) =>
    record(JSON.parse(new TextDecoder().decode(bytes))),
  );
  const first = requests[0];
  const tools = Array.isArray(first?.tools) ? first.tools.map(record) : [];
  const grep = tools.find((tool) => tool?.name === "Grep");
  if (!grep || record(grep.input_schema)?.type !== "object")
    throw new Error("CLAUDE_GREP_PRODUCT_NOT_ADVERTISED");

  const blocks = requests.flatMap((request) =>
    (Array.isArray(request?.messages) ? request.messages : []).flatMap((message) => {
      const content = record(message)?.content;
      return Array.isArray(content) ? content.map(record) : [];
    }),
  );
  const call = blocks.find((block) => block?.type === "tool_use" && block.name === "Grep");
  const args = record(call?.input);
  if (
    typeof call?.id !== "string" ||
    args?.pattern !== "after" ||
    args.path !== path ||
    args.output_mode !== "content"
  )
    throw new Error("CLAUDE_GREP_PRODUCT_CALL_MISSING");
  const result = blocks.find(
    (block) => block?.type === "tool_result" && block.tool_use_id === call.id,
  );
  if (!result || result.is_error === true) throw new Error("CLAUDE_GREP_PRODUCT_RESULT_FAILED");
  const text =
    typeof result.content === "string"
      ? result.content
      : Array.isArray(result.content)
        ? result.content
            .map(record)
            .map((part) => (part?.type === "text" ? part.text : ""))
            .join("")
        : "";
  const lines = text.trim().split(/\r?\n/u);
  const matchingLine =
    lines.includes(`${path}:1:after`) || (lines.includes(path) && lines.includes("1:after"));
  if (!matchingLine) throw new Error("CLAUDE_GREP_PRODUCT_MATCH_TEXT_MISSING");

  const invocations = input.kernelInvocations.map(record).filter((command) => {
    const exit = record(command?.exit);
    return (
      command?.executable === "/bin/rg" &&
      command.toolUseId === call.id &&
      command.toolName === "Grep" &&
      command.runId === input.runId &&
      Array.isArray(command.argv) &&
      command.argv.includes("after") &&
      command.argv.some(
        (argument) =>
          argument === path ||
          (typeof command.cwd === "string" &&
            path.startsWith(`${command.cwd}/`) &&
            argument === path.slice(command.cwd.length + 1)),
      ) &&
      Array.isArray(command.wasmReferences) &&
      command.wasmReferences.includes(KERNEL_RIPGREP_ARTIFACT.sha256) &&
      record(command.route)?.path === input.workRoute &&
      exit?.exitCode === 0 &&
      exit.signal === 0
    );
  });
  const invocation = invocations[0];
  if (!invocation || invocations.length !== 1)
    throw new Error("CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING");
  const events = input.producerEvents
    .map(record)
    .filter(
      (event) =>
        event?.schema === "sb1070/producer/v1" &&
        event.runId === input.runId &&
        event.identity === "command:default" &&
        event.entrypoint === "default" &&
        event.tag === "actual-command-run" &&
        event.producerClass === "dynamic-worker" &&
        record(event.route)?.path === input.workRoute &&
        event.invocationId === invocation.invocationId,
    );
  const joined = events.find(
    (event, enteredIndex) =>
      event?.milestone === "entered" &&
      events.some(
        (terminal, terminalIndex) =>
          terminalIndex > enteredIndex &&
          terminal?.milestone === "terminal" &&
          terminal.invocationId === event.invocationId &&
          terminal.workerId === event.workerId,
      ),
  );
  if (!joined) throw new Error("CLAUDE_GREP_PRODUCT_KERNEL_RG_NOT_JOINED");
  return { toolUseId: call.id, resultText: text, kernelInvocationId: joined.invocationId };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
