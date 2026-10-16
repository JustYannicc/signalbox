import { fillPlaceholders, listedNames } from "@signalbox/runner-protocol/SecretPlaceholders";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeAgentSdkQueryRunnerShape } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { SecretFillable } from "./RunnerSecrets.ts";

/**
 * Fills the agent's `{{secret:NAME}}` placeholders in what it writes or runs
 * (#592): a file it writes or edits holds the real value, and so does a
 * command it runs. The model only ever wrote the placeholder, and whatever it
 * reads back is scrubbed to the placeholder again on the way to it (the
 * ModelGateway, `SecretScrubber.ts`), so a file's own value never reaches it.
 *
 * Filled by the Runner, before Claude Code runs the tool, through a
 * `PreToolUse` hook on each query: deterministic code, never the model. It
 * fails closed: a name the thread has no secret for refuses the call, and so
 * does a machine whose sends nobody checks (`SecretsAccess.guarded`), since
 * once a value is in a file or a command, only the egress check stops it
 * going to a host the person never allowed.
 *
 * Only the tools that write files or run commands are filled. The Runner's own
 * MCP tools are not: they reach Signalbox, not the world, and typing into a
 * browser needs its own origin check.
 *
 * Codex is not filled yet: its hooks only run once someone trusts them in its
 * own UI, which a cloud machine has none of. Its placeholders stay as written,
 * and the egress still fills those its programs send.
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
  | { readonly _tag: "filled"; readonly input: Record<string, unknown> }
  | { readonly _tag: "refused"; readonly reason: string };

/** Fills every string in `value`, collecting what it used and what it couldn't. */
const fillDeep = (
  value: unknown,
  values: ReadonlyMap<string, string>,
  used: Set<string>,
  unknown: Set<string>,
): unknown => {
  if (typeof value === "string") {
    const filled = fillPlaceholders(value, values);
    for (const name of filled.used) used.add(name);
    for (const name of filled.unknown) unknown.add(name);
    return filled.text;
  }
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, values, used, unknown));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillDeep(item, values, used, unknown)]),
    );
  }
  return value;
};

/** What a tool call becomes once its placeholders are filled. */
export const fillToolInput = (
  toolName: string,
  toolInput: unknown,
  fillable: SecretFillable,
): FillOutcome => {
  if (!FILLED_TOOLS.has(toolName) || typeof toolInput !== "object" || toolInput === null) {
    return { _tag: "untouched" };
  }
  const used = new Set<string>();
  const unknown = new Set<string>();
  const input = fillDeep(toolInput, fillable.values, used, unknown) as Record<string, unknown>;
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
  return { _tag: "filled", input };
};

/** The hook's answer to Claude Code for `outcome`. */
const hookOutput = (outcome: FillOutcome): HookJSONOutput => {
  switch (outcome._tag) {
    case "untouched":
      return {};
    case "filled":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: outcome.input,
        },
      };
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

/** The `PreToolUse` hook that fills placeholders, reading the turn's secrets at each call. */
export const secretFillHook = (fillable: () => SecretFillable): HookCallbackMatcher => ({
  hooks: [
    async (input) =>
      input.hook_event_name === "PreToolUse"
        ? hookOutput(fillToolInput(input.tool_name, input.tool_input, fillable()))
        : {},
  ],
});

/** `inner` with every Claude query filling placeholders before its tools run. */
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
