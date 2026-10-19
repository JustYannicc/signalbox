import type {
  HarnessHookCallback,
  HarnessHookEvent,
  HarnessHookRequest,
  HarnessHookResult,
} from "../../src/hooks/HarnessHooks.ts";
import type { HookRegistration } from "../../src/hooks/HookService.ts";
import { codexHarnessHookRequirements } from "../../src/hooks/HarnessHookSettings.ts";

export const CODEX_HOOK_IDS = Object.freeze({
  sessionStart: "codex-session-start-rpc",
  preToolUse: "codex-pre-tool-use-command",
  postToolUse: "codex-post-tool-use-script",
  stop: "codex-stop-rpc",
});

export const CODEX_STANDARD_HOOK_IDS = Object.freeze({
  preToolUse: "codex-standard-pre-tool-use",
  postToolUse: "codex-standard-post-tool-use",
});

export const CODEX_HOOK_REGISTRATIONS = Object.freeze([
  { id: CODEX_HOOK_IDS.sessionStart, event: "session-start", kind: "signalbox" },
  { id: CODEX_HOOK_IDS.preToolUse, event: "pre-tool-use", kind: "command" },
  { id: CODEX_HOOK_IDS.postToolUse, event: "post-tool-use", kind: "script" },
  { id: CODEX_HOOK_IDS.stop, event: "stop", kind: "signalbox" },
] satisfies readonly {
  readonly id: string;
  readonly event: HarnessHookEvent;
  readonly kind: HookRegistration["kind"];
}[]);

export const CODEX_STANDARD_HOOK_REGISTRATIONS = Object.freeze([
  { id: CODEX_STANDARD_HOOK_IDS.preToolUse, event: "pre-tool-use", kind: "signalbox" },
  { id: CODEX_STANDARD_HOOK_IDS.postToolUse, event: "post-tool-use", kind: "signalbox" },
] satisfies readonly {
  readonly id: string;
  readonly event: HarnessHookEvent;
  readonly kind: HookRegistration["kind"];
}[]);

export const CODEX_ALL_HOOK_REGISTRATIONS = Object.freeze([
  ...CODEX_HOOK_REGISTRATIONS,
  ...CODEX_STANDARD_HOOK_REGISTRATIONS,
]);

export const CODEX_SESSION_ID = "codex-hooks-proof-session";
export const CODEX_HOOK_EXECUTABLE = "/usr/bin/signalbox-hook";
export const CODEX_HOOK_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
export const PRE_TOOL_USE_CAPTURE_PATH = "/workspace/codex-hook-inputs/pre-tool-use.json";
// Codex's native hook runner uses this SHELL path when no explicit hook shell is configured.
export const CODEX_NATIVE_HOOK_SHELL = "/bin/bash";

export { HOOK_PROGRAM_FACADE as CODEX_HOOK_PROGRAM_FACADE } from "./hookProgramFacade.ts";

const preToolUseOutput = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "The Codex hook proof allowed this tool call.",
  },
});

export const CODEX_PRE_TOOL_USE_COMMAND = Object.freeze({
  executable: "/bin/bash",
  argv: [
    "/bin/bash",
    "-c",
    [
      "IFS= read -r hook_input || exit 1",
      `printf '%s\\n' "$hook_input" >> ${PRE_TOOL_USE_CAPTURE_PATH}`,
      `printf '%s\\n' "$PROOF_API_TOKEN" >&2`,
      `printf '%s\\n' '${preToolUseOutput}'`,
    ].join("\n"),
  ],
});

export const CODEX_POST_TOOL_USE_PROGRAM = Object.freeze({
  id: "codex-post-tool-use",
  mainModule: "hook.js",
  modules: {
    "hook.js": `export default {
  async fetch(request) {
    const payload = await request.json();
    const valid = payload?.hook_event_name === "PostToolUse";
    return Response.json({
      continue: valid,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: valid
          ? "PostToolUse payload: " + JSON.stringify(payload)
          : "Unexpected Codex hook event.",
      },
    });
  },
};`,
  },
});

export function codexHookRequirements(): string {
  return [
    "allow_managed_hooks_only = true",
    "",
    codexHarnessHookRequirements(CODEX_ALL_HOOK_REGISTRATIONS),
  ].join("\n");
}

export function createCodexHookServiceRegistrations(
  recordSignalboxRequest: (request: HarnessHookRequest) => void,
  standardCallback: HarnessHookCallback,
): ReadonlyMap<string, HookRegistration> {
  const signalboxCallback = async (
    request: HarnessHookRequest,
    { signal }: { readonly signal: AbortSignal },
  ): Promise<HarnessHookResult> => {
    signal.throwIfAborted();
    recordSignalboxRequest(request);
    const result = await standardCallback(request, { signal });
    signal.throwIfAborted();
    if (request.event === "session-start") {
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "Signalbox received the Codex SessionStart event.",
        },
      };
    }
    if (request.event === "stop") return {};
    if (request.event === "pre-tool-use" || request.event === "post-tool-use") return result;
    throw new Error(`Signalbox route was registered for an unsupported event: ${request.event}`);
  };

  return new Map([
    [
      CODEX_HOOK_IDS.sessionStart,
      {
        harness: "codex",
        event: "session-start",
        sessionId: CODEX_SESSION_ID,
        kind: "signalbox",
        callback: signalboxCallback,
      },
    ],
    [
      CODEX_HOOK_IDS.preToolUse,
      {
        harness: "codex",
        event: "pre-tool-use",
        sessionId: CODEX_SESSION_ID,
        kind: "command",
        command: CODEX_PRE_TOOL_USE_COMMAND,
      },
    ],
    [
      CODEX_HOOK_IDS.postToolUse,
      {
        harness: "codex",
        event: "post-tool-use",
        sessionId: CODEX_SESSION_ID,
        kind: "script",
        program: CODEX_POST_TOOL_USE_PROGRAM,
      },
    ],
    [
      CODEX_HOOK_IDS.stop,
      {
        harness: "codex",
        event: "stop",
        sessionId: CODEX_SESSION_ID,
        kind: "signalbox",
        callback: signalboxCallback,
      },
    ],
    [
      CODEX_STANDARD_HOOK_IDS.preToolUse,
      {
        harness: "codex",
        event: "pre-tool-use",
        sessionId: CODEX_SESSION_ID,
        kind: "signalbox",
        callback: signalboxCallback,
      },
    ],
    [
      CODEX_STANDARD_HOOK_IDS.postToolUse,
      {
        harness: "codex",
        event: "post-tool-use",
        sessionId: CODEX_SESSION_ID,
        kind: "signalbox",
        callback: signalboxCallback,
      },
    ],
  ]);
}
