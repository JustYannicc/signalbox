import { HOOK_PROGRAM_FACADE as CLAUDE_HOOK_PROGRAM_FACADE } from "./hookProgramFacade.ts";
import type { MemoryFilePersistenceFixture } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type {
  FileCommitReceipt,
  FilePersistenceResult,
} from "../../src/kernel/FilePersistencePorts.ts";
import type { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import type {
  HarnessHookCallback,
  HarnessHookEvent,
  HarnessHookRequest,
} from "../../src/hooks/HarnessHooks.ts";
import type { HookRegistration } from "../../src/hooks/HookService.ts";
import { KERNEL_HOOK_EXECUTABLE } from "../../src/hooks/HookProgram.ts";
import {
  claudeHarnessHookSettings,
  type ConfiguredHarnessHook,
} from "../../src/hooks/HarnessHookSettings.ts";
import type { MockToolResult } from "../claudeTurnProof/mockMessages.ts";
import type { ClaudeHooksDispatchRecord } from "./claudeEvidence.ts";
import { STANDARD_PROOF_WRITE, STANDARD_PROOF_FILLED_WRITE } from "./standardProofAdapter.ts";

export const CLAUDE_HOOK_SETTINGS_PATH = "/home/claude/.claude/settings.json";
export const CLAUDE_HOOK_COMMAND_LOG = "/work/hook-command-events.jsonl";
export const CLAUDE_TOOL_FILE = "/work/official-write.txt";
export const CLAUDE_TOOL_CONTENT = STANDARD_PROOF_WRITE;
export const CLAUDE_HOOK_SESSION_ID = "claude-hooks-proof-session";
export { HOOK_PROGRAM_FACADE as CLAUDE_HOOK_PROGRAM_FACADE } from "./hookProgramFacade.ts";

export const CLAUDE_HOOK_EVENTS = [
  { event: "session-start", officialName: "SessionStart" },
  { event: "pre-tool-use", officialName: "PreToolUse" },
  { event: "post-tool-use", officialName: "PostToolUse" },
  { event: "stop", officialName: "Stop" },
] as const satisfies readonly {
  readonly event: HarnessHookEvent;
  readonly officialName: string;
}[];

export const CLAUDE_HOOK_ROUTES = ["command", "signalbox", "script"] as const;
export type ClaudeHookRoute = (typeof CLAUDE_HOOK_ROUTES)[number];

export interface ClaudeHookScenario {
  readonly registrations: ReadonlyMap<string, HookRegistration>;
  readonly settings: ReturnType<typeof claudeHarnessHookSettings>;
  readonly configuredHooks: readonly ConfiguredHarnessHook[];
  readonly rpcCalls: HarnessHookRequest[];
}

const BASE = Object.freeze({
  repository: "claude-hooks-proof",
  fork: "official-hooks",
  commit: "fixture-base",
});

export function createClaudeHookScenario(
  callback: HarnessHookCallback = async () => ({}),
): ClaudeHookScenario {
  const registrations = new Map<string, HookRegistration>();
  const configuredHooks: ConfiguredHarnessHook[] = [];
  const rpcCalls: HarnessHookRequest[] = [];

  for (const { event } of CLAUDE_HOOK_EVENTS) {
    for (const kind of CLAUDE_HOOK_ROUTES) {
      const id = hookId(event, kind);
      configuredHooks.push({ id, event });
      registrations.set(id, registration(event, kind, rpcCalls, callback));
    }
  }

  return {
    registrations,
    settings: claudeHarnessHookSettings(configuredHooks),
    configuredHooks,
    rpcCalls,
  };
}

function hookId(event: HarnessHookEvent, kind: ClaudeHookRoute): string {
  return "claude-" + event + "-" + kind;
}

function registration(
  event: HarnessHookEvent,
  kind: ClaudeHookRoute,
  rpcCalls: HarnessHookRequest[],
  callback: HarnessHookCallback,
): HookRegistration {
  const context = {
    harness: "claude-code" as const,
    event,
    sessionId: CLAUDE_HOOK_SESSION_ID,
  };
  if (kind === "command") {
    return {
      ...context,
      kind,
      command: {
        executable: "/bin/bash",
        argv: [
          "/bin/bash",
          "-c",
          [
            "cat >> " + CLAUDE_HOOK_COMMAND_LOG,
            `printf '%s\\n' "$PROOF_API_TOKEN" >&2`,
            `printf '%s\\n' "$PROOF_VAULT_TOKEN" >&2`,
          ].join("\n"),
        ],
      },
    };
  }
  if (kind === "signalbox") {
    return {
      ...context,
      kind,
      callback: async (request, options) => {
        options.signal.throwIfAborted();
        rpcCalls.push(request);
        return callback(request, options);
      },
    };
  }
  const officialName = CLAUDE_HOOK_EVENTS.find((entry) => entry.event === event)!.officialName;
  return {
    ...context,
    kind,
    program: {
      id: "claude-hook-script-" + event,
      mainModule: "hook.js",
      modules: {
        "hook.js":
          "export default { async fetch(request) { const input = await request.json(); const valid = input?.hook_event_name === " +
          JSON.stringify(officialName) +
          ' && input?.cwd === "/work"; return Response.json({continue:valid}); } };',
      },
    },
  };
}

export function seedClaudeHookScenario(
  host: {
    readonly filesystem: KernelFileSystem;
    readonly fs: NodeFsModules;
    readonly ports: MemoryFilePersistenceFixture;
  },
  settings: ClaudeHookScenario["settings"],
): void {
  seedFile(host, CLAUDE_TOOL_FILE, "before the official tool call\n");
  seedFile(host, CLAUDE_HOOK_COMMAND_LOG, "");
  host.fs.fs.mkdirSync("/usr/bin", { recursive: true });
  seedFile(host, KERNEL_HOOK_EXECUTABLE, CLAUDE_HOOK_PROGRAM_FACADE, 0o755);
  host.fs.fs.mkdirSync("/home/claude/.claude", { recursive: true });
  host.fs.fs.writeFileSync(CLAUDE_HOOK_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function seedFile(
  host: {
    readonly filesystem: KernelFileSystem;
    readonly fs: NodeFsModules;
    readonly ports: MemoryFilePersistenceFixture;
  },
  path: string,
  text: string,
  mode?: number,
): void {
  const bytes = new TextEncoder().encode(text);
  host.fs.fs.writeFileSync(path, bytes);
  host.ports.seedFile(BASE, path, bytes);
  if (mode !== undefined) host.filesystem.chmod(path, mode);
}

export function claudeToolScript() {
  return {
    name: "Write" as const,
    input: {
      file_path: CLAUDE_TOOL_FILE,
      content: CLAUDE_TOOL_CONTENT,
    },
  };
}

export async function verifyClaudeHookScenario(input: {
  readonly filesystem: KernelFileSystem;
  readonly fs: NodeFsModules;
  readonly ports: MemoryFilePersistenceFixture;
  readonly persistence: Pick<ReturnType<typeof createFacetFilePersistence>, "commitTurn">;
  readonly dispatches: readonly ClaudeHooksDispatchRecord[];
  readonly rpcCalls: readonly HarnessHookRequest[];
  readonly stdout: string;
  readonly mockComplete: boolean;
  readonly toolResults: readonly MockToolResult[];
  readonly machineCalls: number;
}): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const hookProgramFacade = inspectHookProgramFacade(input.filesystem, input.fs, errors);
  const expected = new Map<string, { event: HarnessHookEvent; route: ClaudeHookRoute }>();
  for (const { event } of CLAUDE_HOOK_EVENTS) {
    for (const route of CLAUDE_HOOK_ROUTES) expected.set(hookId(event, route), { event, route });
  }

  for (const [id, target] of expected) {
    const calls = input.dispatches.filter((dispatch) => dispatch.id === id);
    if (calls.length !== 1) {
      errors.push(id + " expected one official invocation, got " + calls.length);
      continue;
    }
    const call = calls[0]!;
    if (call.event !== target.event || call.route !== target.route) {
      errors.push(id + " was dispatched through the wrong event or route");
    }
    if (call.exit?.exitCode !== 0 || call.exit.signal !== 0) {
      errors.push(id + " did not exit successfully");
    }
    verifyOfficialPayload(call.payload, target.event, errors);
    if (target.route === "script") verifyGeneratedOutput(call.stdout, target.event, errors);
    if (target.route === "signalbox" && call.stdout?.trim() !== "{}") {
      errors.push(id + " did not return a neutral standard hook result");
    }
    if (
      target.route === "command" &&
      call.stderr !== "{{secret:API_TOKEN}}\n{{secret:VAULT_TOKEN}}\n"
    ) {
      errors.push(id + " did not scrub the real command environment output before the harness");
    }
  }

  for (const { event, officialName } of CLAUDE_HOOK_EVENTS) {
    const calls = input.dispatches.filter((dispatch) => dispatch.event === event);
    const payloads = calls.map((call) => JSON.stringify(call.payload));
    if (calls.length === CLAUDE_HOOK_ROUTES.length && new Set(payloads).size !== 1) {
      errors.push(officialName + " handlers received different event payloads");
    }
  }
  verifyEventOrder(input.dispatches, errors);
  verifyCommandFile(input.fs, input.dispatches, errors);
  verifyRpcRouting(input.dispatches, input.rpcCalls, errors);

  if (!input.mockComplete) errors.push("mock Messages script did not complete");
  if (input.toolResults.length !== 1 || input.toolResults[0]?.name !== "Write") {
    errors.push("expected exactly one successful official Write tool result");
  }
  if (input.toolResults[0]?.is_error) errors.push("official Write tool call returned an error");
  if (input.machineCalls !== 0) errors.push("hook command execution reached the machine port");

  const stdoutEvents = parseClaudeStdout(input.stdout, errors);
  const terminal = stdoutEvents.at(-1);
  const terminalSuccess =
    terminal?.type === "result" && terminal.subtype === "success" && terminal.is_error === false;
  if (!terminalSuccess) errors.push("Claude did not end with a successful result event");

  const actualFiles = {
    [CLAUDE_TOOL_FILE]: readText(input.fs, CLAUDE_TOOL_FILE),
    [CLAUDE_HOOK_COMMAND_LOG]: readText(input.fs, CLAUDE_HOOK_COMMAND_LOG),
  };
  if (actualFiles[CLAUDE_TOOL_FILE] !== STANDARD_PROOF_FILLED_WRITE) {
    errors.push("official Claude Write did not produce the expected file");
  }

  let commitReceipt: FilePersistenceResult<FileCommitReceipt> | undefined;
  if (terminalSuccess && input.mockComplete) {
    const changedInodes = [CLAUDE_TOOL_FILE, CLAUDE_HOOK_COMMAND_LOG].map((path) => ({
      inode: input.filesystem.resolve(path).inode,
      paths: [path],
      removedPaths: [],
    }));
    commitReceipt = await input.persistence.commitTurn({
      at: BASE,
      turnId: "official-claude-hooks-turn",
      changedInodes,
      signal: new AbortController().signal,
    });
  }

  const committed = committedFiles(input.ports, commitReceipt);
  const expectedCommandPayloads = input.dispatches
    .filter((dispatch) => dispatch.route === "command")
    .map((dispatch) => JSON.stringify(dispatch.payload))
    .sort();
  const actualCommandPayloads = (actualFiles[CLAUDE_HOOK_COMMAND_LOG] ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    JSON.stringify([...actualCommandPayloads].sort()) !== JSON.stringify(expectedCommandPayloads)
  ) {
    errors.push("command hook file does not contain the exact official payload records");
  }
  if (committed[CLAUDE_TOOL_FILE] !== actualFiles[CLAUDE_TOOL_FILE]) {
    errors.push("committed Claude tool file differs from the SQLite result");
  }
  if (committed[CLAUDE_HOOK_COMMAND_LOG] !== actualFiles[CLAUDE_HOOK_COMMAND_LOG]) {
    errors.push("committed command hook file differs from the SQLite result");
  }
  if (commitReceipt?.status !== "ok") errors.push("successful file commit evidence is missing");

  return {
    ok: errors.length === 0,
    errors,
    officialEventRecords: input.dispatches,
    rpcRouting: { kind: "standard-hooks-with-restart-module-test-adapters", calls: input.rpcCalls },
    timing: hookTiming(input.dispatches),
    machineCalls: input.machineCalls,
    settingsPath: CLAUDE_HOOK_SETTINGS_PATH,
    hookProgramFacade,
    terminalEvent: terminal,
    files: [
      {
        path: CLAUDE_TOOL_FILE,
        input: CLAUDE_TOOL_CONTENT,
        expected: STANDARD_PROOF_FILLED_WRITE,
        actual: actualFiles[CLAUDE_TOOL_FILE],
        committed: committed[CLAUDE_TOOL_FILE],
      },
      {
        path: CLAUDE_HOOK_COMMAND_LOG,
        expected: expectedCommandPayloads.join("\n") + "\n",
        actual: actualFiles[CLAUDE_HOOK_COMMAND_LOG],
        committed: committed[CLAUDE_HOOK_COMMAND_LOG],
      },
    ],
    commitReceipt,
  };
}

function inspectHookProgramFacade(
  filesystem: KernelFileSystem,
  fs: NodeFsModules,
  errors: string[],
) {
  let fileType: string | null = null;
  let bytes: number | null = null;
  let mode: number | null = null;
  try {
    const stat = filesystem.stat(KERNEL_HOOK_EXECUTABLE);
    fileType = stat.type;
    bytes = Number(stat.size);
    mode = filesystem.getPosixMetadata(KERNEL_HOOK_EXECUTABLE).mode & 0o777;
  } catch {
    // The inventory below records a missing facade without hiding other proof results.
  }
  const source = readText(fs, KERNEL_HOOK_EXECUTABLE) ?? null;
  const expectedBytes = new TextEncoder().encode(CLAUDE_HOOK_PROGRAM_FACADE).byteLength;
  if (
    fileType !== "file" ||
    bytes !== expectedBytes ||
    mode !== 0o755 ||
    source !== CLAUDE_HOOK_PROGRAM_FACADE
  ) {
    errors.push("registered hook executable facade is missing its source bytes or mode 0755");
  }
  return {
    path: KERNEL_HOOK_EXECUTABLE,
    fileType,
    bytes,
    mode,
    source,
  };
}

function verifyOfficialPayload(payload: unknown, event: HarnessHookEvent, errors: string[]): void {
  if (!isRecord(payload)) {
    errors.push(event + " payload was not an official JSON object");
    return;
  }
  const expectedName = CLAUDE_HOOK_EVENTS.find((entry) => entry.event === event)?.officialName;
  if (payload.hook_event_name !== expectedName) {
    errors.push(event + " payload did not retain its official hook_event_name");
  }
  if (typeof payload.session_id !== "string" || payload.session_id.length === 0) {
    errors.push(event + " payload is missing the official session_id");
  }
  if (payload.cwd !== "/work") errors.push(event + " payload did not retain the session cwd");
  if (
    (event === "pre-tool-use" || event === "post-tool-use") &&
    (payload.tool_name !== "Write" ||
      !isRecord(payload.tool_input) ||
      payload.tool_input.file_path !== CLAUDE_TOOL_FILE ||
      payload.tool_input.content !== CLAUDE_TOOL_CONTENT)
  ) {
    errors.push(event + " payload did not identify the single Write tool call");
  }
  if (event === "post-tool-use" && !Object.hasOwn(payload, "tool_response")) {
    errors.push("PostToolUse payload is missing tool_response");
  }
}

function verifyEventOrder(
  dispatches: readonly ClaudeHooksDispatchRecord[],
  errors: string[],
): void {
  const order = CLAUDE_HOOK_EVENTS.map(({ event }) =>
    dispatches.findIndex((dispatch) => dispatch.event === event),
  );
  if (
    order.some((index) => index < 0) ||
    order.some((index, offset) => offset > 0 && index < order[offset - 1]!)
  ) {
    errors.push("official Claude hook events did not follow the expected lifecycle order");
  }
}

function verifyCommandFile(
  fs: NodeFsModules,
  dispatches: readonly ClaudeHooksDispatchRecord[],
  errors: string[],
): void {
  if (!fs.fs.existsSync(CLAUDE_HOOK_COMMAND_LOG)) {
    errors.push("configured command hooks did not create their output file");
    return;
  }
  const text = readText(fs, CLAUDE_HOOK_COMMAND_LOG);
  if (text === undefined) {
    errors.push("configured command hooks did not create their output file");
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (
    lines.length !==
    CLAUDE_HOOK_EVENTS.length * CLAUDE_HOOK_ROUTES.filter((route) => route === "command").length
  ) {
    errors.push("configured command hooks did not write one line per event");
  }
  const expected = dispatches
    .filter((dispatch) => dispatch.route === "command")
    .map((dispatch) => JSON.stringify(dispatch.payload))
    .sort();
  if (JSON.stringify([...lines].sort()) !== JSON.stringify(expected)) {
    errors.push("configured command hooks changed or lost official stdin payload bytes");
  }
}

function verifyRpcRouting(
  dispatches: readonly ClaudeHooksDispatchRecord[],
  calls: readonly HarnessHookRequest[],
  errors: string[],
): void {
  for (const { event } of CLAUDE_HOOK_EVENTS) {
    const eventCalls = calls.filter((call) => call.event === event);
    if (eventCalls.length !== 1 || eventCalls[0]?.harness !== "claude-code") {
      errors.push(event + " did not route once through the Signalbox callback fixture");
      continue;
    }
    const dispatch = dispatches.find(
      (record) => record.event === event && record.route === "signalbox",
    );
    if (isRecord(dispatch?.payload) && eventCalls[0]?.sessionId !== dispatch.payload.session_id) {
      errors.push(event + " Signalbox fixture did not retain the official session_id");
    }
  }
}

function verifyGeneratedOutput(
  stdout: string | undefined,
  event: HarnessHookEvent,
  errors: string[],
): void {
  try {
    const result: unknown = JSON.parse(stdout ?? "");
    if (!isRecord(result) || result.continue !== true) {
      errors.push(event + " generated script did not validate its event payload");
    }
  } catch {
    errors.push(event + " generated script did not return JSON");
  }
}

function parseClaudeStdout(stdout: string, errors: string[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  stdout.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.type !== "string") {
        errors.push("stdout line " + (index + 1) + " is not a Claude event");
      } else {
        events.push(value);
      }
    } catch {
      errors.push("stdout line " + (index + 1) + " is not JSON");
    }
  });
  return events;
}

function committedFiles(
  ports: MemoryFilePersistenceFixture,
  receipt: FilePersistenceResult<FileCommitReceipt> | undefined,
): Record<string, string | undefined> {
  if (receipt?.status !== "ok") {
    return { [CLAUDE_TOOL_FILE]: undefined, [CLAUDE_HOOK_COMMAND_LOG]: undefined };
  }
  const tree = ports.inspectTree({ ...BASE, commit: receipt.value.commit });
  return {
    [CLAUDE_TOOL_FILE]: readBytes(tree?.[CLAUDE_TOOL_FILE]?.data),
    [CLAUDE_HOOK_COMMAND_LOG]: readBytes(tree?.[CLAUDE_HOOK_COMMAND_LOG]?.data),
  };
}

function readText(fs: NodeFsModules, path: string): string | undefined {
  if (!fs.fs.existsSync(path)) return undefined;
  const bytes = fs.fs.readFileSync(path);
  return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
}

function readBytes(bytes: Uint8Array | null | undefined): string | undefined {
  return bytes == null ? undefined : new TextDecoder().decode(bytes);
}

function hookTiming(dispatches: readonly ClaudeHooksDispatchRecord[]) {
  return {
    clock: "node:process.hrtime.bigint",
    unit: "milliseconds converted from nanoseconds",
    precision: "nanosecond counter units; underlying host clock resolution is not guaranteed",
    scope: "host-side HookService.invoke duration, including generated response body consumption",
    limitations:
      "Excludes provider scheduling and whole CLI turn latency. Null means the clock was unavailable or did not advance during the call.",
    byRoute: Object.fromEntries(
      CLAUDE_HOOK_ROUTES.map((route) => [
        route,
        routeTiming(dispatches.filter((dispatch) => dispatch.route === route)),
      ]),
    ),
  };
}

function routeTiming(dispatches: readonly ClaudeHooksDispatchRecord[]) {
  const measured = dispatches
    .map((dispatch) => dispatch.elapsedMs)
    .filter((value): value is number => value !== null);
  const unavailable = dispatches.filter((dispatch) => dispatch.elapsedMs === null);
  return {
    invocations: dispatches.length,
    measuredInvocations: measured.length,
    unavailableInvocations: unavailable.length,
    elapsedMs:
      dispatches.length > 0 && unavailable.length === 0
        ? measured.reduce((sum, value) => sum + value, 0)
        : null,
    samplesMs: dispatches.map((dispatch) => ({
      id: dispatch.id,
      elapsedMs: dispatch.elapsedMs,
      ...(dispatch.timingUnavailableReason === undefined
        ? {}
        : { reason: dispatch.timingUnavailableReason }),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
