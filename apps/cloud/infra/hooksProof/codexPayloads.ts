import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
// @ts-expect-error The shared MJS fixture has no declaration.
import { EXEC_ARGUMENTS, PATCH_INPUT } from "../codexTurn/MockResponses.mjs";
import {
  CODEX_HOOK_IDS,
  CODEX_HOOK_REGISTRATIONS,
  CODEX_STANDARD_HOOK_REGISTRATIONS,
  CODEX_STANDARD_HOOK_IDS,
} from "./codexScenario.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
  type StandardProofAdapter,
} from "./standardProofAdapter.ts";

type StandardInspection = ReturnType<StandardProofAdapter["inspect"]>;
export type CodexStandardHookInspection = Pick<StandardInspection, "ok"> & {
  readonly gateway: Pick<
    StandardInspection["gateway"],
    "beforeToolUse" | "afterToolUse" | "commandEnvironments"
  >;
};

export const CODEX_STANDARD_DISPATCH_IDS = new Set<string>([
  CODEX_HOOK_IDS.sessionStart,
  ...CODEX_STANDARD_HOOK_REGISTRATIONS.map(({ id }) => id),
  CODEX_HOOK_IDS.stop,
]);

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
  const originalIds = new Set<string>(CODEX_HOOK_REGISTRATIONS.map(({ id }) => id));
  const originalInvocations = invocations.filter((entry) => originalIds.has(entry.id));
  const session = record(originalInvocations[0]?.input)?.session_id;
  const turn = record(originalInvocations[1]?.input)?.turn_id;
  if (typeof session !== "string" || session.length === 0)
    failures.push("SessionStart did not supply a native session_id");
  for (const [index, entry] of originalInvocations.entries()) {
    const wanted = expected[index];
    const payload = record(entry.input);
    if (!wanted || entry.event !== wanted.event)
      failures.push(`Native hook order differs at invocation ${index}`);
    if (!payload || payload.session_id !== session || payload.cwd !== "/workspace")
      failures.push(`${entry.id} lost its native session_id or cwd`);
    if (
      entry.event !== "session-start" &&
      (typeof turn !== "string" || turn.length === 0 || payload?.turn_id !== turn)
    )
      failures.push(`${entry.id} did not retain the native turn_id`);
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
      const pre = record(originalInvocations[index - 1]?.input);
      if (JSON.stringify(pre?.tool_input) !== JSON.stringify(payload?.tool_input))
        failures.push(`${entry.id} changed tool_input between PreToolUse and PostToolUse`);
      const response = payload?.tool_response;
      if (
        typeof response !== "string" ||
        !response.includes(wanted.tool === "Bash" ? "codex-exec-proof" : "A /workspace/proof.txt")
      )
        failures.push(`${entry.id} lost the real tool_response`);
    }
  }
  return failures;
}

export function verifyCodexStandardHookPayloads(
  invocations: readonly { readonly id: string; readonly event: string; readonly input: unknown }[],
) {
  const failures: string[] = [];
  const standardIds = [
    CODEX_HOOK_IDS.sessionStart,
    CODEX_STANDARD_HOOK_IDS.preToolUse,
    CODEX_STANDARD_HOOK_IDS.postToolUse,
    CODEX_STANDARD_HOOK_IDS.preToolUse,
    CODEX_STANDARD_HOOK_IDS.postToolUse,
    CODEX_HOOK_IDS.stop,
  ];
  const standardIdSet = new Set<string>(standardIds);
  const standardInvocations = invocations.filter((entry) => standardIdSet.has(entry.id));
  if (standardInvocations.length !== expected.length)
    failures.push(`Expected ${expected.length} standard hook payloads`);

  for (const [index, wanted] of expected.entries()) {
    const entry = standardInvocations[index];
    const expectedId = standardIds[index];
    if (!entry || !expectedId) {
      failures.push(`Missing standard hook payload at invocation ${index}`);
      continue;
    }
    const payload = record(entry.input);
    if (entry.id !== expectedId || entry.event !== wanted.event)
      failures.push(`Standard hook order differs at invocation ${index}`);
    if (!payload || payload.cwd !== "/workspace") failures.push(`${entry.id} lost its native cwd`);
    if (index > 0 && payload?.session_id !== record(standardInvocations[0]?.input)?.session_id)
      failures.push(`${entry.id} changed native session_id`);
    if (wanted.event !== "session-start") {
      const firstTurn = record(standardInvocations[1]?.input)?.turn_id;
      if (typeof firstTurn !== "string" || payload?.turn_id !== firstTurn)
        failures.push(`${entry.id} did not retain the native turn_id`);
    }
    if (!("tool" in wanted)) continue;

    const input = record(payload?.tool_input);
    if (
      payload?.tool_name !== wanted.tool ||
      payload.tool_use_id !== wanted.id ||
      typeof input?.command !== "string" ||
      input.command !== (wanted.tool === "Bash" ? EXEC_ARGUMENTS.cmd : PATCH_INPUT)
    )
      failures.push(`${entry.id} lost the expected standard tool payload`);
    if (entry.event === "post-tool-use") {
      const pre = record(standardInvocations[index - 1]?.input);
      if (JSON.stringify(pre?.tool_input) !== JSON.stringify(payload?.tool_input))
        failures.push(`${entry.id} changed tool_input between standard pre and post hooks`);
      const response = payload?.tool_response;
      if (
        typeof response !== "string" ||
        !response.includes(wanted.tool === "Bash" ? "codex-exec-proof" : "A /workspace/proof.txt")
      )
        failures.push(`${entry.id} lost the real standard tool_response`);
    }

    const originalId =
      entry.event === "pre-tool-use" ? CODEX_HOOK_IDS.preToolUse : CODEX_HOOK_IDS.postToolUse;
    const original = invocations.find(
      (candidate) =>
        candidate.id === originalId &&
        candidate.event === entry.event &&
        record(candidate.input)?.tool_use_id === payload?.tool_use_id,
    );
    if (!original || JSON.stringify(original.input) !== JSON.stringify(entry.input))
      failures.push(
        `${entry.id} did not receive the full native payload used by its original hook`,
      );
  }

  for (const id of standardIdSet) {
    const expectedCount = standardIds.filter((expectedId) => expectedId === id).length;
    const actualCount = standardInvocations.filter((entry) => entry.id === id).length;
    if (actualCount !== expectedCount)
      failures.push(`${id} ran ${actualCount} times instead of ${expectedCount}`);
  }
  return failures;
}

export function verifyCodexStandardHookResults(
  invocations: readonly { readonly id: string; readonly kind: string; readonly stdout?: string }[],
  inspection: CodexStandardHookInspection,
) {
  const failures: string[] = [];
  if (!inspection.ok) failures.push("Standard hook adapter inspection failed");
  const gateway = inspection.gateway;
  for (const key of ["beforeToolUse", "afterToolUse", "commandEnvironments"] as const) {
    const count = gateway[key];
    if (typeof count !== "number" || count <= 0)
      failures.push(`Standard hook proof recorded no Gateway ${key} activity`);
  }
  const standardIds = new Set<string>(CODEX_STANDARD_HOOK_REGISTRATIONS.map(({ id }) => id));
  for (const invocation of invocations.filter(({ id }) => standardIds.has(id))) {
    if (invocation.kind !== "signalbox")
      failures.push(`${invocation.id} was not classified as a Signalbox hook`);
    const result = record(parseJson(invocation.stdout));
    if (!result || Object.keys(result).length !== 0)
      failures.push(`${invocation.id} returned something other than the neutral standard result`);
  }
  return failures;
}

export function redactCodexProofText(value: string): string {
  return value
    .replaceAll(
      STANDARD_PROOF_NAMED_SECRET.value,
      secretPlaceholder(STANDARD_PROOF_NAMED_SECRET.name),
    )
    .replaceAll(
      STANDARD_PROOF_VAULT_SECRET.value,
      secretPlaceholder(STANDARD_PROOF_VAULT_SECRET.name),
    );
}

export function redactCodexProofValue(value: unknown): unknown {
  if (typeof value === "string") return redactCodexProofText(value);
  if (Array.isArray(value)) return value.map(redactCodexProofValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactCodexProofValue(entry)]),
  );
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
