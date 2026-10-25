import type { HarnessHookJson } from "../../src/hooks/HarnessHooks.ts";
import type { HookRegistration } from "../../src/hooks/HookService.ts";

/** Native identifiers are callback data. Thread authority comes from its host closure. */
export function withOfficialHookContext(
  registration: HookRegistration,
  payload: HarnessHookJson,
): HookRegistration {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return registration;
  const sessionId = Reflect.get(payload, "session_id");
  if (typeof sessionId !== "string" || sessionId.length === 0) return registration;
  const turnId = Reflect.get(payload, "turn_id");
  const toolCallId = Reflect.get(payload, "tool_use_id");
  return {
    ...registration,
    sessionId,
    ...(typeof turnId === "string" ? { turnId } : {}),
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
  };
}
