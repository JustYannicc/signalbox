export type HarnessHookJson =
  | null
  | boolean
  | number
  | string
  | readonly HarnessHookJson[]
  | { readonly [key: string]: HarnessHookJson };

export type HarnessHookEvent = "session-start" | "pre-tool-use" | "post-tool-use" | "stop";

export interface HarnessHookRequest {
  readonly harness: "claude-code" | "codex";
  readonly event: HarnessHookEvent;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  /** Official hook input, without renaming or dropping harness-specific fields. */
  readonly payload: HarnessHookJson;
}

/** Official hook output, including decision fields interpreted by the harness. */
export type HarnessHookResult = HarnessHookJson;

export interface HarnessHookInvocationOptions {
  /** Host cancellation stays outside the serializable hook request. */
  readonly signal: AbortSignal;
}

export type HarnessHookCallback = (
  request: HarnessHookRequest,
  options: HarnessHookInvocationOptions,
) => Promise<HarnessHookResult>;
