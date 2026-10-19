import type { HarnessHookEvent } from "./HarnessHooks.ts";
import { KERNEL_HOOK_EXECUTABLE } from "./HookProgram.ts";

const eventNames = {
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
} as const satisfies Record<HarnessHookEvent, string>;

export interface ConfiguredHarnessHook {
  readonly id: string;
  readonly event: HarnessHookEvent;
}

/** Official settings invoke a registered program; only the host holds handler definitions. */
export function claudeHarnessHookSettings(registrations: readonly ConfiguredHarnessHook[]) {
  const hooks: Record<string, { hooks: { type: "command"; command: string }[] }[]> = {};
  for (const registration of registrations) {
    const event = eventNames[registration.event];
    const group = (hooks[event] ??= [{ hooks: [] }])[0]!;
    group.hooks.push({ type: "command", command: hookCommand(registration.id) });
  }
  return { hooks };
}

/** Host-owned Codex requirements are policy-trusted without weakening user hook trust. */
export function codexHarnessHookRequirements(registrations: readonly ConfiguredHarnessHook[]) {
  return [
    "[features]",
    "hooks = true",
    "",
    "[hooks]",
    'managed_dir = "/usr/bin"',
    ...registrations.flatMap((registration) => [
      "",
      `[[hooks.${eventNames[registration.event]}]]`,
      `[[hooks.${eventNames[registration.event]}.hooks]]`,
      'type = "command"',
      `command = '${hookCommand(registration.id)}'`,
    ]),
    "",
  ].join("\n");
}

function hookCommand(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new TypeError("Hook registration IDs must contain only ASCII letters, digits, _ or -");
  }
  return `${KERNEL_HOOK_EXECUTABLE} ${id}`;
}
