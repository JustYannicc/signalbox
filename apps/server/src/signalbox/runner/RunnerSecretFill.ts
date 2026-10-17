import { placeholderNames, listedNames } from "@signalbox/runner-protocol/SecretPlaceholders";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeAgentSdkQueryRunnerShape } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { SecretFillable } from "./RunnerSecrets.ts";

/**
 * Validates tool placeholders without resolving them. Files, shell arguments,
 * harness logs and Git keep references; only the external egress broker may
 * replace a reference with a value. Reads are also scrubbed by ModelGateway.
 */

/** Claude Code's tools that write files or run commands. */
const FILLED_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

export type FillOutcome =
  | { readonly _tag: "untouched" }
  | { readonly _tag: "refused"; readonly reason: string };

/** Collects references in nested tool inputs without making a copy with values. */
const namesIn = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [...placeholderNames(value)];
  if (Array.isArray(value)) return value.flatMap(namesIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(namesIn);
  return [];
};

/** Validates references before a file or command tool runs. */
export const fillToolInput = (
  toolName: string,
  toolInput: unknown,
  fillable: SecretFillable,
): FillOutcome => {
  if (!FILLED_TOOLS.has(toolName) || typeof toolInput !== "object" || toolInput === null) {
    return { _tag: "untouched" };
  }
  const named = namesIn(toolInput);
  const used = new Set(named.filter((name) => fillable.values.has(name)));
  const unknown = new Set(named.filter((name) => !fillable.values.has(name)));
  if (used.size === 0 && unknown.size === 0) return { _tag: "untouched" };
  if (unknown.size > 0) {
    return {
      _tag: "refused",
      reason:
        fillable.values.size === 0
          ? `This thread has no secret called ${listedNames(unknown)}: its folders give it none.`
          : `This thread has no secret called ${listedNames(unknown)}. It has: ${listedNames(fillable.values.keys())}.`,
    };
  }
  if (!fillable.guarded) {
    return {
      _tag: "refused",
      reason: `This machine can't check where secrets get sent yet, so ${listedNames(used)} isn't filled in here. Placeholders only work on threads that run on a light machine for now.`,
    };
  }
  return { _tag: "untouched" };
};

/** The hook's answer to Claude Code for `outcome`. */
const hookOutput = (outcome: FillOutcome): HookJSONOutput => {
  switch (outcome._tag) {
    case "untouched":
      return {};
    case "refused":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: outcome.reason,
        },
      };
  }
};

/** Checks references against the turn's available secrets at each tool call. */
export const secretFillHook = (fillable: () => SecretFillable): HookCallbackMatcher => ({
  hooks: [
    async (input) =>
      input.hook_event_name === "PreToolUse"
        ? hookOutput(fillToolInput(input.tool_name, input.tool_input, fillable()))
        : {},
  ],
});

/** Installs placeholder validation on each Claude query. */
export const withSecretFill = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  fillable: () => SecretFillable,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) => {
    const hooks = input.options.hooks ?? {};
    return inner.open({
      ...input,
      options: {
        ...input.options,
        hooks: {
          ...hooks,
          PreToolUse: [...(hooks.PreToolUse ?? []), secretFillHook(fillable)],
        },
      },
    });
  },
});
