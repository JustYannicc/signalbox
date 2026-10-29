import type {
  HarnessToolHookReceipt,
  HarnessToolTraceGap,
  HookPairing,
  MutableChildProcess,
  HarnessExpectedToolCall,
  HarnessTraceField,
} from "./types.ts";

export function pairHooks(
  preHooks: readonly HarnessToolHookReceipt[],
  terminalHooks: readonly HarnessToolHookReceipt[],
  gaps: HarnessToolTraceGap[],
): Map<number, HookPairing> {
  const pairs = new Map<number, HookPairing>(
    preHooks.map((pre) => [pre.sequence, { reasons: [] }]),
  );
  const closed = new Set<number>();
  for (const terminal of terminalHooks) {
    const key = validHookKey(terminal);
    if (key === undefined) {
      gaps.push({
        scope: "hook",
        reason: "terminal-hook-missing-identity",
        processKey: terminal.processKey,
        hookSequence: terminal.sequence,
      });
      continue;
    }
    const candidates = preHooks.filter(
      (pre) =>
        pre.sequence < terminal.sequence && !closed.has(pre.sequence) && validHookKey(pre) === key,
    );
    if (candidates.length === 1) {
      const pre = candidates[0]!;
      pairs.set(pre.sequence, { terminal, reasons: [] });
      closed.add(pre.sequence);
      continue;
    }
    if (candidates.length > 1) {
      for (const pre of candidates)
        pairs.set(pre.sequence, { reasons: ["ambiguous-terminal-pair"] });
      gaps.push({
        scope: "hook",
        reason: "ambiguous-terminal-pair",
        processKey: terminal.processKey,
        hookSequence: terminal.sequence,
        candidateHookSequences: candidates.map((pre) => pre.sequence),
      });
      continue;
    }
    const prior = preHooks.filter((pre) => validHookKey(pre) === key && closed.has(pre.sequence));
    if (prior.length > 0) {
      for (const pre of prior) {
        const pairing = pairs.get(pre.sequence)!;
        pairs.set(pre.sequence, {
          ...pairing,
          reasons: [...pairing.reasons, "duplicate-terminal-hook"],
        });
      }
      gaps.push({
        scope: "hook",
        reason: "duplicate-terminal-hook",
        processKey: terminal.processKey,
        hookSequence: terminal.sequence,
        candidateHookSequences: prior.map((pre) => pre.sequence),
      });
    } else {
      gaps.push({
        scope: "hook",
        reason: "orphan-terminal-hook",
        processKey: terminal.processKey,
        hookSequence: terminal.sequence,
      });
    }
  }
  for (const pre of preHooks) {
    if (validHookKey(pre) === undefined) {
      const pairing = pairs.get(pre.sequence)!;
      pairs.set(pre.sequence, {
        ...pairing,
        reasons: [...pairing.reasons, "pre-hook-missing-identity"],
      });
      gaps.push({
        scope: "hook",
        reason: "pre-hook-missing-identity",
        processKey: pre.processKey,
        hookSequence: pre.sequence,
      });
    }
  }
  return pairs;
}

export function findWindowChildren(
  pre: HarnessToolHookReceipt,
  terminal: HarnessToolHookReceipt | undefined,
  children: readonly MutableChildProcess[],
) {
  if (terminal === undefined || terminal.sequence <= pre.sequence) return [];
  return children.filter(
    (child) =>
      child.processKey === pre.processKey &&
      child.sequence > pre.sequence &&
      child.sequence < terminal.sequence,
  );
}

export function expectedMatchesPre(
  expected: HarnessExpectedToolCall,
  hook: HarnessToolHookReceipt,
): boolean {
  if (!fieldEquals(hook.fields.tool_use_id, expected.id)) return false;
  if (expected.processKey !== undefined && hook.processKey !== expected.processKey) return false;
  if (expected.sessionId !== undefined && !fieldEquals(hook.fields.session_id, expected.sessionId))
    return false;
  return true;
}

export function expectedMatchesHook(
  expected: HarnessExpectedToolCall,
  hook: HarnessToolHookReceipt,
): boolean {
  return expected.name === fieldValue(hook.fields.tool_name) && expectedMatchesPre(expected, hook);
}

export function sameHookIdentity(
  left: HarnessToolHookReceipt,
  right: HarnessToolHookReceipt,
): boolean {
  return (
    left.processKey === right.processKey &&
    validHookKey(left) !== undefined &&
    validHookKey(left) === validHookKey(right)
  );
}

export function validHookKey(hook: HarnessToolHookReceipt): string | undefined {
  const sessionId = fieldValue(hook.fields.session_id);
  const toolUseId = fieldValue(hook.fields.tool_use_id);
  if (
    hook.processKey.length === 0 ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof toolUseId !== "string" ||
    toolUseId.length === 0
  )
    return;
  return JSON.stringify([hook.processKey, sessionId, toolUseId]);
}

export function callbackIdMismatch(hook: HarnessToolHookReceipt): boolean {
  const native = hook.fields.tool_use_id;
  if (native.state === "missing") return hook.callbackToolUseId !== undefined;
  return native.value !== hook.callbackToolUseId;
}

export function fieldEquals(field: HarnessTraceField, value: unknown): boolean {
  return field.state === "present" && field.value === value;
}

function fieldValue(field: HarnessTraceField): unknown {
  return field.state === "present" ? field.value : undefined;
}

export function duplicateExpectedKeys(
  expectedCalls: readonly HarnessExpectedToolCall[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const expected of expectedCalls) {
    const key = expectedKey(expected);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function expectedKey(expected: HarnessExpectedToolCall): string {
  return JSON.stringify([
    expected.id,
    expected.processKey === undefined ? [false] : [true, expected.processKey],
    expected.sessionId === undefined ? [false] : [true, expected.sessionId],
  ]);
}

export function readField(value: unknown, key: string): HarnessTraceField {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return { state: "missing" };
  return { state: "present", value: Reflect.get(value, key) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
