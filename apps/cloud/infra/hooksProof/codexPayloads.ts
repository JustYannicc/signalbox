const expected = [
  { event: "session-start" },
  { event: "pre-tool-use", tool: "Bash", id: "call-1069-exec" },
  { event: "post-tool-use", tool: "Bash", id: "call-1069-exec" },
  { event: "pre-tool-use", tool: "apply_patch", id: "call-1069-apply-patch" },
  { event: "post-tool-use", tool: "apply_patch", id: "call-1069-apply-patch" },
  { event: "stop" },
] as const;

/** Verifies native event identity and pairing independently of callback output. */
export function verifyCodexHookPayloads(
  invocations: readonly { readonly id: string; readonly event: string; readonly input: unknown }[],
) {
  const failures: string[] = [];
  const session = record(invocations[0]?.input)?.session_id;
  if (typeof session !== "string" || session.length === 0)
    failures.push("SessionStart did not supply a native session_id");
  for (const [index, entry] of invocations.entries()) {
    const wanted = expected[index];
    const payload = record(entry.input);
    if (!wanted || entry.event !== wanted.event)
      failures.push(`Native hook order differs at invocation ${index}`);
    if (!payload || payload.session_id !== session || payload.cwd !== "/workspace")
      failures.push(`${entry.id} lost its native session_id or cwd`);
    if (!wanted || !("tool" in wanted)) continue;
    const input = record(payload?.tool_input);
    if (
      payload?.tool_name !== wanted.tool ||
      payload.tool_use_id !== wanted.id ||
      typeof input?.command !== "string" ||
      input.command !== (wanted.tool === "Bash" ? EXEC_ARGUMENTS.cmd : PATCH_INPUT)
    )
      failures.push(`${entry.id} lost the expected native tool call`);
    if (entry.event === "post-tool-use") {
      const pre = record(invocations[index - 1]?.input);
      if (JSON.stringify(pre?.tool_input) !== JSON.stringify(payload?.tool_input))
        failures.push(`${entry.id} changed tool_input between PreToolUse and PostToolUse`);
      const response = payload?.tool_response;
      if (
        typeof response !== "string" ||
        !response.includes(wanted.tool === "Bash" ? "codex-exec-proof" : "A /workspace/proof.txt")
      )
        failures.push(`${entry.id} lost the real tool_response`);
    }
    if (typeof payload?.turn_id !== "string" || payload.turn_id.length === 0)
      failures.push(`${entry.id} lost turn_id`);
  }
  return failures;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
// @ts-expect-error The shared MJS fixture has no declaration.
import { EXEC_ARGUMENTS, PATCH_INPUT } from "../codexTurn/MockResponses.mjs";
