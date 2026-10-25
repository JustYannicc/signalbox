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
import {
  inspectStandardProofSessions,
  type StandardProofSessionBaseline,
} from "./standardProofRecords.ts";
import {
  inspectStandardProofNativeFileRead,
  STANDARD_PROOF_WIRE_TEXT,
  type StandardProofNativeFileRead,
} from "./standardProofEvidence.ts";
import { matchesClaudeNativeFileRead } from "./claudeNativeFileRead.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
  STANDARD_PROOF_WRITE,
} from "./standardProofAdapter.ts";

export const CLAUDE_HOOK_SETTINGS_PATH = "/home/claude/.claude/settings.json";
export const CLAUDE_HOOK_COMMAND_LOG = "/work/hook-command-events.jsonl";
export const CLAUDE_TOOL_FILE = "/work/official-write.txt";
export const CLAUDE_TOOL_CONTENT = STANDARD_PROOF_WRITE;
export const CLAUDE_TOOL_READ_COMMAND = `cat ${CLAUDE_TOOL_FILE}`;
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
  return claudeToolScripts()[0];
}

export function claudeToolScripts() {
  return [
    {
      name: "Write" as const,
      input: {
        file_path: CLAUDE_TOOL_FILE,
        content: CLAUDE_TOOL_CONTENT,
      },
    },
    {
      name: "Read" as const,
      input: { file_path: CLAUDE_TOOL_FILE },
    },
    {
      name: "Bash" as const,
      input: { command: CLAUDE_TOOL_READ_COMMAND },
    },
  ] as const;
}

export type ClaudeNativeFileReadEvidence = StandardProofNativeFileRead;

export function inspectClaudeNativeFileRead(read: ClaudeNativeFileReadEvidence | undefined) {
  const result = inspectStandardProofNativeFileRead(read, CLAUDE_TOOL_READ_COMMAND);
  return {
    ...result,
    commandMatched:
      result.commandMatched || matchesClaudeNativeFileRead(read, CLAUDE_TOOL_READ_COMMAND),
  };
}

export async function verifyClaudeHookScenario(input: {
  readonly filesystem: KernelFileSystem;
  readonly fs: NodeFsModules;
  readonly sessionBaseline: StandardProofSessionBaseline;
  readonly ports: MemoryFilePersistenceFixture;
  readonly persistence: Pick<ReturnType<typeof createFacetFilePersistence>, "commitTurn">;
  readonly dispatches: readonly ClaudeHooksDispatchRecord[];
  readonly rpcCalls: readonly HarnessHookRequest[];
  readonly stdout: string;
  readonly mockComplete: boolean;
  readonly toolResults: readonly MockToolResult[];
  readonly machineCalls: number;
  readonly nativeFileRead?: ClaudeNativeFileReadEvidence | undefined;
}): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const hookProgramFacade = inspectHookProgramFacade(input.filesystem, input.fs, errors);
  const expected = new Map<
    string,
    { event: HarnessHookEvent; route: ClaudeHookRoute; count: number }
  >();
  for (const { event } of CLAUDE_HOOK_EVENTS) {
    for (const route of CLAUDE_HOOK_ROUTES) {
      expected.set(hookId(event, route), {
        event,
        route,
        count: event === "pre-tool-use" || event === "post-tool-use" ? 3 : 1,
      });
    }
  }

  for (const [id, target] of expected) {
    const calls = input.dispatches.filter((dispatch) => dispatch.id === id);
    if (calls.length !== target.count) {
      errors.push(id + " expected " + target.count + " official invocations, got " + calls.length);
    }
    for (const call of calls) {
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
  }

  for (const { event, officialName } of CLAUDE_HOOK_EVENTS) {
    const calls = input.dispatches.filter((dispatch) => dispatch.event === event);
    const groups = new Map<string, ClaudeHooksDispatchRecord[]>();
    for (const call of calls) {
      const payload = isRecord(call.payload) ? call.payload : {};
      const key =
        typeof payload.tool_name === "string"
          ? JSON.stringify([payload.tool_name, payload.tool_input])
          : "lifecycle";
      const group = groups.get(key) ?? [];
      group.push(call);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const payloads = group.map((call) => JSON.stringify(call.payload));
      if (group.length === CLAUDE_HOOK_ROUTES.length && new Set(payloads).size !== 1) {
        errors.push(officialName + " handlers received different event payloads");
      }
    }
  }
  verifyEventOrder(input.dispatches, errors);
  verifyCommandFile(input.fs, input.dispatches, errors);
  verifyRpcRouting(input.dispatches, input.rpcCalls, errors);

  if (!input.mockComplete) errors.push("mock Messages script did not complete");
  const expectedToolNames = ["Write", "Read", "Bash"];
  if (
    input.toolResults.length !== expectedToolNames.length ||
    input.toolResults.some((result, index) => result.name !== expectedToolNames[index])
  ) {
    errors.push("expected successful official Write, Read, and Bash tool results in order");
  }
  if (input.toolResults.some((result) => result.is_error))
    errors.push("an official Claude tool call returned an error");
  const expectedCanonicalRead = STANDARD_PROOF_WRITE.trimEnd();
  const officialReadReturnedPlaceholders =
    containsText(input.toolResults[1]?.content, expectedCanonicalRead) &&
    !containsText(input.toolResults[1]?.content, STANDARD_PROOF_NAMED_SECRET.value) &&
    !containsText(input.toolResults[1]?.content, STANDARD_PROOF_VAULT_SECRET.value);
  if (!officialReadReturnedPlaceholders)
    errors.push("official Claude Read did not return canonical placeholder file content");
  const expectedWireRead = STANDARD_PROOF_WIRE_TEXT;
  const modelWireStayedScrubbed =
    containsText(input.toolResults[2]?.content, expectedWireRead.trimEnd()) &&
    !containsText(input.toolResults[2]?.content, STANDARD_PROOF_NAMED_SECRET.value) &&
    !containsText(input.toolResults[2]?.content, STANDARD_PROOF_VAULT_SECRET.value);
  if (!modelWireStayedScrubbed)
    errors.push("official Claude Bash result did not keep secrets scrubbed on the model wire");
  if (input.machineCalls !== 0) errors.push("hook command execution reached the machine port");

  const nativeFileRead = inspectClaudeNativeFileRead(input.nativeFileRead);
  if (!nativeFileRead.commandMatched)
    errors.push("Claude did not execute the expected native cat command");
  if (!nativeFileRead.matchesFilledBytes)
    errors.push("Claude native cat output did not match the filled file bytes");

  const stdoutEvents = parseClaudeStdout(input.stdout, errors);
  const terminal = stdoutEvents.at(-1);
  const terminalSuccess =
    terminal?.type === "result" && terminal.subtype === "success" && terminal.is_error === false;
  if (!terminalSuccess) errors.push("Claude did not end with a successful result event");

  const actualFiles = {
    [CLAUDE_TOOL_FILE]: readText(input.fs, CLAUDE_TOOL_FILE),
    [CLAUDE_HOOK_COMMAND_LOG]: readText(input.fs, CLAUDE_HOOK_COMMAND_LOG),
  };
  if (actualFiles[CLAUDE_TOOL_FILE] !== STANDARD_PROOF_WRITE) {
    errors.push("official Claude Write did not retain placeholder bytes in the canonical file");
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
  if (committed[CLAUDE_TOOL_FILE] !== STANDARD_PROOF_WRITE) {
    errors.push("committed Claude tool file did not retain placeholder bytes");
  }
  if (committed[CLAUDE_TOOL_FILE] !== actualFiles[CLAUDE_TOOL_FILE]) {
    errors.push("committed Claude tool file differs from the canonical filesystem result");
  }
  if (committed[CLAUDE_HOOK_COMMAND_LOG] !== actualFiles[CLAUDE_HOOK_COMMAND_LOG]) {
    errors.push("committed command hook file differs from the SQLite result");
  }
  if (commitReceipt?.status !== "ok") errors.push("successful file commit evidence is missing");
  const sessionMirror = inspectStandardProofSessions(
    input.filesystem,
    "/home/claude/.claude/projects",
    input.sessionBaseline,
  );
  errors.push(...sessionMirror.errors);

  return {
    ok: errors.length === 0,
    errors,
    sessionMirror,
    officialEventRecords: input.dispatches,
    rpcRouting: {
      kind: "standard-hooks-with-restart-module-test-adapters",
      calls: input.rpcCalls,
    },
    timing: hookTiming(input.dispatches),
    machineCalls: input.machineCalls,
    settingsPath: CLAUDE_HOOK_SETTINGS_PATH,
    hookProgramFacade,
    terminalEvent: terminal,
    nativeFileFill: {
      kind: "official-write-canonical-read-and-bash-cat",
      path: CLAUDE_TOOL_FILE,
      command: CLAUDE_TOOL_READ_COMMAND,
      commandMatched: nativeFileRead.commandMatched,
      rawOutputBytes: nativeFileRead.outputBytes,
      expectedFilledBytes: nativeFileRead.expectedBytes,
      matchesFilledBytes: nativeFileRead.matchesFilledBytes,
      canonicalPlaceholderBytes: new TextEncoder().encode(actualFiles[CLAUDE_TOOL_FILE] ?? "")
        .byteLength,
      canonicalMatchesPlaceholders: actualFiles[CLAUDE_TOOL_FILE] === STANDARD_PROOF_WRITE,
      officialReadReturnedPlaceholders,
      modelWireStayedScrubbed,
    },
    files: [
      {
        path: CLAUDE_TOOL_FILE,
        input: CLAUDE_TOOL_CONTENT,
        expected: STANDARD_PROOF_WRITE,
        bytes: new TextEncoder().encode(actualFiles[CLAUDE_TOOL_FILE] ?? "").byteLength,
        canonicalMatches: actualFiles[CLAUDE_TOOL_FILE] === STANDARD_PROOF_WRITE,
        committedMatches: committed[CLAUDE_TOOL_FILE] === STANDARD_PROOF_WRITE,
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
  if (event === "pre-tool-use" || event === "post-tool-use") {
    const expectedTool = claudeToolScripts().find((tool) => tool.name === payload.tool_name);
    if (
      expectedTool === undefined ||
      JSON.stringify(payload.tool_input) !== JSON.stringify(expectedTool.input)
    ) {
      errors.push(event + " payload did not identify an expected native tool call");
    }
  }
  if (event === "post-tool-use" && !Object.hasOwn(payload, "tool_response")) {
    errors.push("PostToolUse payload is missing tool_response");
  }
  if (event === "post-tool-use" && payload.tool_name === "Read") {
    if (!containsText(payload.tool_response, STANDARD_PROOF_WRITE.trimEnd()))
      errors.push("PostToolUse Read payload did not retain canonical placeholder content");
  }
  if (event === "post-tool-use" && payload.tool_name === "Bash") {
    const expectedWireRead = STANDARD_PROOF_WIRE_TEXT;
    if (
      !containsText(payload.tool_response, expectedWireRead.trimEnd()) ||
      containsText(payload.tool_response, STANDARD_PROOF_NAMED_SECRET.value) ||
      containsText(payload.tool_response, STANDARD_PROOF_VAULT_SECRET.value)
    ) {
      errors.push("PostToolUse Bash payload did not keep secret output scrubbed");
    }
  }
}

function verifyEventOrder(
  dispatches: readonly ClaudeHooksDispatchRecord[],
  errors: string[],
): void {
  const sessionStart = dispatches.findIndex((dispatch) => dispatch.event === "session-start");
  const firstPre = dispatches.findIndex((dispatch) => dispatch.event === "pre-tool-use");
  const postIndices = dispatches
    .map((dispatch, index) => (dispatch.event === "post-tool-use" ? index : -1))
    .filter((index) => index >= 0);
  const lastPost = postIndices.at(-1) ?? -1;
  const stop = dispatches.findIndex((dispatch) => dispatch.event === "stop");
  if (sessionStart < 0 || firstPre < sessionStart || lastPost < firstPre || stop < lastPost) {
    errors.push("official Claude hook events did not follow the expected lifecycle order");
  }

  let previousPost = -1;
  for (const tool of claudeToolScripts()) {
    const key = JSON.stringify(tool.input);
    const preIndices: number[] = [];
    const postToolIndices: number[] = [];
    for (const route of CLAUDE_HOOK_ROUTES) {
      const before = dispatches.findIndex(
        (dispatch) =>
          dispatch.event === "pre-tool-use" &&
          dispatch.route === route &&
          isRecord(dispatch.payload) &&
          dispatch.payload.tool_name === tool.name &&
          JSON.stringify(dispatch.payload.tool_input) === key,
      );
      const after = dispatches.findIndex(
        (dispatch) =>
          dispatch.event === "post-tool-use" &&
          dispatch.route === route &&
          isRecord(dispatch.payload) &&
          dispatch.payload.tool_name === tool.name &&
          JSON.stringify(dispatch.payload.tool_input) === key,
      );
      if (before < 0 || after < before) {
        errors.push(tool.name + " did not finish its native pre/post hook sequence");
      }
      preIndices.push(before);
      postToolIndices.push(after);
    }
    const firstPre = Math.min(...preIndices);
    const lastToolPost = Math.max(...postToolIndices);
    if (firstPre <= previousPost) {
      errors.push("Claude native tools did not run in the scripted order");
    }
    previousPost = lastToolPost;
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
  const expectedLines = CLAUDE_HOOK_EVENTS.reduce(
    (sum, { event }) => sum + (event === "pre-tool-use" || event === "post-tool-use" ? 3 : 1),
    0,
  );
  if (
    lines.length !==
    expectedLines * CLAUDE_HOOK_ROUTES.filter((route) => route === "command").length
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
    const eventDispatches = dispatches.filter(
      (record) => record.event === event && record.route === "signalbox",
    );
    const expectedCount = event === "pre-tool-use" || event === "post-tool-use" ? 3 : 1;
    if (
      eventCalls.length !== expectedCount ||
      eventDispatches.length !== expectedCount ||
      eventCalls.some((call) => call.harness !== "claude-code")
    ) {
      errors.push(
        event + " did not route each native event through the Signalbox callback fixture",
      );
      continue;
    }
    for (const dispatch of eventDispatches) {
      if (!isRecord(dispatch.payload)) continue;
      const matches = eventCalls.filter(
        (call) => JSON.stringify(call.payload) === JSON.stringify(dispatch.payload),
      );
      if (matches.length !== 1 || matches[0]?.sessionId !== dispatch.payload.session_id) {
        errors.push(event + " Signalbox fixture did not retain its official payload");
      }
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

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, text));
  return isRecord(value) && Object.values(value).some((entry) => containsText(entry, text));
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
