import type {
  HarnessToolHookReceipt,
  HarnessToolTraceJoinProvenance,
  HarnessToolTracePathMapping,
  HookPairing,
  MutableChildProcess,
  ShellCandidate,
} from "./types.ts";
import { extractClaudeBashWrapper } from "./claudeBashWrapper.ts";
import { callbackIdMismatch, fieldEquals, findWindowChildren, readField } from "./matching.ts";

export function findShellCandidates(
  preHooks: readonly HarnessToolHookReceipt[],
  pairings: ReadonlyMap<number, HookPairing>,
  children: readonly MutableChildProcess[],
  pathMapping?: HarnessToolTracePathMapping,
): ShellCandidate[] {
  const rows: ShellCandidate[] = [];
  for (const pre of preHooks) {
    const pairing = pairings.get(pre.sequence);
    const terminal = pairing?.terminal;
    if (
      pairing === undefined ||
      terminal === undefined ||
      pairing.reasons.length > 0 ||
      !fieldEquals(pre.fields.hook_event_name, "PreToolUse") ||
      !fieldEquals(terminal.fields.hook_event_name, terminal.event) ||
      !fieldEquals(pre.fields.tool_name, "Bash") ||
      !fieldEquals(terminal.fields.tool_name, "Bash") ||
      callbackIdMismatch(pre) ||
      callbackIdMismatch(terminal)
    )
      continue;
    const command = bashCommand(pre);
    if (command === undefined) continue;
    const inWindow = findWindowChildren(pre, terminal, children);
    const matches: { child: MutableChildProcess; provenance: HarnessToolTraceJoinProvenance }[] =
      [];
    let unsupportedWrapperReason: string | undefined;
    let cwdMismatch = false;
    for (const child of inWindow) {
      const extraction = shellCommand(child);
      if (extraction === undefined) continue;
      if (extraction.kind === "gap") {
        unsupportedWrapperReason ??= extraction.reason;
        continue;
      }
      // Strict string equality preserves newlines and normalization code units.
      if (extraction.command !== command.script) continue;
      const cwd = matchCwd(command.cwd, child.cwd, pathMapping);
      if (!cwd.matched) {
        cwdMismatch = true;
        continue;
      }
      matches.push({
        child,
        provenance: { ...extraction.provenance, pathMappingId: cwd.pathMappingId },
      });
    }
    rows.push({
      pre,
      children: matches.map((match) => match.child),
      provenance: matches.map((match) => ({
        childId: match.child.childId,
        value: match.provenance,
      })),
      ...(matches.length > 0
        ? {}
        : {
            reason: unsupportedWrapperReason
              ? `unsupported-shell-wrapper:${unsupportedWrapperReason}`
              : cwdMismatch
                ? "cwd-mapping-mismatch"
                : "no-exact-shell-child-match",
          }),
    });
  }
  return rows;
}

interface ShellCommandMatch {
  readonly kind: "matched";
  readonly command: string;
  readonly provenance: Omit<HarnessToolTraceJoinProvenance, "pathMappingId">;
}

type ShellCommandResult = ShellCommandMatch | { readonly kind: "gap"; readonly reason: string };

function shellCommand(child: MutableChildProcess): ShellCommandResult | undefined {
  if (child.executable !== "/bin/bash" && child.executable !== "/bin/sh") return;
  const wrapper = extractClaudeBashWrapper(child.executable, child.argv);
  if (wrapper.kind === "gap") return wrapper;
  return {
    kind: "matched",
    command: wrapper.value.command,
    provenance: {
      templateId: wrapper.value.templateId,
      operandSpan: wrapper.value.operandSpan,
    },
  };
}

function matchCwd(
  hookCwd: string,
  spawnCwd: string,
  mapping: HarnessToolTracePathMapping | undefined,
): { readonly matched: true; readonly pathMappingId: string | null } | { readonly matched: false } {
  if (hookCwd === spawnCwd) return { matched: true, pathMappingId: null };
  if (mapping === undefined || mapping.id.length === 0) return { matched: false };
  const privatePaths = [mapping.sourceRepositoryPrivate];
  if (mapping.cwdMapped || mapping.cwdPrivate === mapping.sourceRepositoryPrivate) {
    privatePaths.push(mapping.cwdPrivate);
  }
  if (
    (hookCwd === "/work" && privatePaths.includes(spawnCwd)) ||
    (spawnCwd === "/work" && privatePaths.includes(hookCwd))
  ) {
    return { matched: true, pathMappingId: mapping.id };
  }
  return { matched: false };
}

function bashCommand(
  pre: HarnessToolHookReceipt,
): { readonly script: string; readonly cwd: string } | undefined {
  const input = pre.fields.tool_input;
  const cwd = pre.fields.cwd;
  if (
    input.state !== "present" ||
    !isRecord(input.value) ||
    cwd.state !== "present" ||
    typeof cwd.value !== "string"
  )
    return;
  const command = readField(input.value, "command");
  if (command.state !== "present" || typeof command.value !== "string") return;
  return { script: command.value, cwd: cwd.value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
