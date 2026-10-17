import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeAgentSdkQueryRunnerShape } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { SecretFillable } from "./RunnerSecrets.ts";

/** Local files and commands keep placeholders; only the outbound broker resolves them. */
export type FillOutcome = { readonly _tag: "untouched" };

/** Keeps existing callers source-compatible while local inputs remain literal. */
export const fillToolInput = (
  _toolName: string,
  _toolInput: unknown,
  _fillable: SecretFillable,
): FillOutcome => ({ _tag: "untouched" });

/** Local tool use never resolves or rejects a placeholder. */
export const secretFillHook = (_fillable: () => SecretFillable): HookCallbackMatcher => ({
  hooks: [async (): Promise<HookJSONOutput> => ({})],
});

/** Preserves the adapter seam while outbound-only substitution is handled elsewhere. */
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
