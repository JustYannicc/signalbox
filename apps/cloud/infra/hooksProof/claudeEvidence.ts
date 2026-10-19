import type { HarnessHookEvent, HarnessHookJson } from "../../src/hooks/HarnessHooks.ts";
import type { HookRegistration } from "../../src/hooks/HookService.ts";
import type { KernelCommandExit } from "../../src/kernel/KernelCommandForwarder.ts";

export interface ClaudeHooksDispatchRecord {
  readonly id: string;
  readonly event: HarnessHookEvent;
  readonly route: HookRegistration["kind"];
  readonly payload: HarnessHookJson;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  exit?: KernelCommandExit;
  stdout?: string;
  stderr?: string;
  error?: string;
}
