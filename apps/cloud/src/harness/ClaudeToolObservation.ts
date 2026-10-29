import type { ClaudeAgentSdkQueryOptions } from "@signalbox/provider-claude/ClaudeQueryRunner";

type SdkHooks = NonNullable<ClaudeAgentSdkQueryOptions["hooks"]>;
type SdkCallback = NonNullable<SdkHooks["PreToolUse"]>[number]["hooks"][number];
type SdkHookInput = Parameters<SdkCallback>[0];
export type ClaudeToolHookInput = Extract<
  SdkHookInput,
  { hook_event_name: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" }
>;

export interface ClaudeToolHookObservation {
  readonly input: ClaudeToolHookInput;
  readonly toolUseId: string | undefined;
  readonly signal: AbortSignal;
}

export interface ClaudeToolHookMeasurement {
  readonly event: string;
  readonly toolUseId: string | undefined;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly durationMs: number;
}

/** Registers observation through the SDK; capture failures cannot become tool decisions. */
export function createClaudeToolObservation(
  observe: (event: ClaudeToolHookObservation) => unknown,
  now: () => number = () => performance.now(),
) {
  const failures: {
    readonly event: string;
    readonly toolUseId: string | undefined;
    readonly error: unknown;
  }[] = [];
  const measurements: ClaudeToolHookMeasurement[] = [];
  const pending = new Set<Promise<void>>();
  const callback: SdkCallback = async (input, toolUseId, { signal }) => {
    const finished = Promise.withResolvers<void>();
    pending.add(finished.promise);
    const startedAtMs = now();
    try {
      if (
        input.hook_event_name !== "PreToolUse" &&
        input.hook_event_name !== "PostToolUse" &&
        input.hook_event_name !== "PostToolUseFailure"
      )
        throw new Error("Unexpected SDK tool observation event");
      await observe({ input, toolUseId, signal });
    } catch (error) {
      failures.push({ event: input.hook_event_name, toolUseId, error });
    } finally {
      const completedAtMs = now();
      measurements.push({
        event: input.hook_event_name,
        toolUseId,
        startedAtMs,
        completedAtMs,
        durationMs: completedAtMs - startedAtMs,
      });
      pending.delete(finished.promise);
      finished.resolve();
    }
    return {};
  };
  const hooks = {
    PreToolUse: [{ hooks: [callback] }],
    PostToolUse: [{ hooks: [callback] }],
    PostToolUseFailure: [{ hooks: [callback] }],
  } satisfies SdkHooks;
  return {
    hooks,
    withHooks(existing: SdkHooks | undefined): SdkHooks {
      if (existing === undefined) return hooks;
      return {
        ...existing,
        PreToolUse: [...(existing.PreToolUse ?? []), ...hooks.PreToolUse],
        PostToolUse: [...(existing.PostToolUse ?? []), ...hooks.PostToolUse],
        PostToolUseFailure: [...(existing.PostToolUseFailure ?? []), ...hooks.PostToolUseFailure],
      };
    },
    snapshot: () => ({
      failures: [...failures],
      measurements: [...measurements],
      pending: pending.size,
    }),
    async drain() {
      while (pending.size > 0) await Promise.all(pending);
    },
  };
}

export type ClaudeToolObservation = ReturnType<typeof createClaudeToolObservation>;
