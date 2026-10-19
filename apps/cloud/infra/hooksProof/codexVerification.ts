import { HOOK_PROGRAM_FACADE } from "./hookProgramFacade.ts";
import type { HookExecutionResult } from "../../src/hooks/HookService.ts";
import type { HarnessHookJson, HarnessHookRequest } from "../../src/hooks/HarnessHooks.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { KernelHandle } from "../../src/kernel/KernelAbi.ts";
import type { KernelCommandExit } from "../../src/kernel/KernelCommandForwarder.ts";
import type { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { NodeGeneratedCodeInvokeInput } from "../../src/isolate/NodeGeneratedCode.ts";
import { verifyCodexHookPayloads } from "./codexPayloads.ts";
import {
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_REGISTRATIONS,
  CODEX_HOOK_REQUIREMENTS_PATH,
  CODEX_NATIVE_HOOK_SHELL,
  CODEX_POST_TOOL_USE_PROGRAM,
  codexHookRequirements,
  PRE_TOOL_USE_CAPTURE_PATH,
} from "./codexScenario.ts";

export const CODEX_HOOK_MODES = Object.freeze({
  "session-start": "signalbox",
  "pre-tool-use": "command",
  "post-tool-use": "script",
  stop: "signalbox",
} as const);

const officialEventNames = Object.freeze({
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
} as const);

// The shared turn executes Bash and apply_patch, so each tool event fires twice.
const expectedInvocations = { "session-start": 1, "pre-tool-use": 2, "post-tool-use": 2, stop: 1 };

export type CodexHookKind = (typeof CODEX_HOOK_MODES)[keyof typeof CODEX_HOOK_MODES];

export interface HookInvocationRecord {
  readonly id: string;
  readonly event: keyof typeof CODEX_HOOK_MODES;
  readonly kind: CodexHookKind;
  readonly input: HarnessHookJson;
  readonly startedAtMs: number | null;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  stdout?: string;
  stderr?: string;
  exit?: HookExecutionResult["exit"];
  error?: string;
}

export interface IsolateCallRecord {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly startedAtMs: number | null;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  exit?: KernelCommandExit;
  error?: string;
}

export interface GeneratedCallRecord {
  readonly id: string;
  readonly input: NodeGeneratedCodeInvokeInput["input"];
  readonly startedAtMs: number | null;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  status?: number;
  error?: string;
}

export interface SignalboxCallRecord {
  readonly request: HarnessHookRequest;
}

export interface SpawnCallRecord {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  readonly startedAtMs: number | null;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  result?: string;
}

export interface CodexHookVerificationInput {
  readonly filesystem: KernelFileSystem;
  readonly host: KernelProgramHost;
  readonly parent: KernelHandle<"process">;
  readonly invocations: readonly HookInvocationRecord[];
  readonly isolateCalls: readonly IsolateCallRecord[];
  readonly generatedCalls: readonly GeneratedCallRecord[];
  readonly signalboxCalls: readonly SignalboxCallRecord[];
  readonly spawnCalls: readonly SpawnCallRecord[];
  readonly machineAttempts: readonly {
    readonly executable: string;
    readonly argv: readonly string[];
  }[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const executableFacade = encoder.encode(HOOK_PROGRAM_FACADE);

/** Checks official event results and the process paths the unchanged CLI actually used. */
export async function verifyCodexHooks(input: CodexHookVerificationInput) {
  const failures = verifyCodexHookPayloads(input.invocations);
  const hookFile = inspectFile(input.filesystem, CODEX_HOOK_EXECUTABLE);
  const settingsFile = inspectFile(input.filesystem, CODEX_HOOK_REQUIREMENTS_PATH);
  const settingsText = settingsFile.text ?? "";
  const expectedIds = CODEX_HOOK_REGISTRATIONS.map(({ id }) => id);
  const events = CODEX_HOOK_REGISTRATIONS.map(({ id, event }) => {
    const kind = CODEX_HOOK_MODES[event];
    const records = input.invocations.filter((invocation) => invocation.id === id);
    const record = records[0];
    const expectedEventName = officialEventNames[event];
    const inputEventName = readRecord(record?.input)?.hook_event_name;
    return {
      id,
      event,
      kind,
      invocationCount: records.length,
      observed: record !== undefined,
      inputEventName: typeof inputEventName === "string" ? inputEventName : null,
      inputPreserved: inputEventName === expectedEventName,
      elapsedMs: record?.elapsedMs ?? null,
      timingUnavailableReason: record?.timingUnavailableReason ?? null,
      exit: record?.exit ?? null,
      stdout: record?.stdout ?? null,
      stderr: record?.stderr ?? null,
      error: record?.error ?? null,
    };
  });

  for (const event of events) {
    if (event.invocationCount !== expectedInvocations[event.event])
      failures.push(`Unexpected ${event.event} invocation count: ${event.invocationCount}`);
    if (!event.observed) failures.push(`Missing ${event.event} handler invocation`);
    if (!event.inputPreserved) failures.push(`${event.event} input did not retain hook_event_name`);
    if (!successfulExit(event.exit))
      failures.push(`${event.event} handler did not exit successfully`);
    if (event.error) failures.push(`${event.event} handler failed: ${event.error}`);
  }
  const expectedInvocationCount = Object.values(expectedInvocations).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (input.invocations.length !== expectedInvocationCount)
    failures.push(`Expected ${expectedInvocationCount} native hook invocations`);
  for (const record of input.invocations) {
    if (readRecord(record.input)?.hook_event_name !== officialEventNames[record.event])
      failures.push(`${record.id} received the wrong official event payload`);
    if (!successfulExit(record.exit) || record.error)
      failures.push(`${record.id} did not complete successfully`);
    const result = parseObject(record.stdout);
    if (!result) {
      failures.push(`${record.id} did not return a JSON object`);
    } else if (record.event === "stop") {
      if (Object.keys(result).length !== 0)
        failures.push(`${record.id} returned an invalid Stop result`);
    } else {
      if (
        readNestedString(result, ["hookSpecificOutput", "hookEventName"]) !==
        officialEventNames[record.event]
      )
        failures.push(`${record.id} returned the wrong result event`);
      if (
        record.event === "pre-tool-use" &&
        readNestedString(result, ["hookSpecificOutput", "permissionDecision"]) !== "allow"
      )
        failures.push(`${record.id} did not return an allow decision`);
      if (
        record.event === "post-tool-use" &&
        (result.continue !== true ||
          readNestedString(result, ["hookSpecificOutput", "additionalContext"]) !==
            `PostToolUse payload: ${JSON.stringify(record.input)}`)
      )
        failures.push(`${record.id} did not validate its PostToolUse payload`);
    }
  }

  const sessionStart = outputFor(input.invocations, CODEX_HOOK_REGISTRATIONS[0]!.id);
  if (readNestedString(sessionStart, ["hookSpecificOutput", "hookEventName"]) !== "SessionStart")
    failures.push("SessionStart callback returned the wrong official result event");
  const preToolUse = outputFor(input.invocations, CODEX_HOOK_REGISTRATIONS[1]!.id);
  if (
    readNestedString(preToolUse, ["hookSpecificOutput", "hookEventName"]) !== "PreToolUse" ||
    readNestedString(preToolUse, ["hookSpecificOutput", "permissionDecision"]) !== "allow"
  ) {
    failures.push("PreToolUse command did not return the official allow result");
  }
  const postToolUseRecord = input.invocations.find(
    (record) => record.id === CODEX_HOOK_REGISTRATIONS[2]!.id,
  );
  const postToolUse = parseObject(postToolUseRecord?.stdout);
  if (postToolUse?.continue !== true)
    failures.push("Generated PostToolUse handler did not return continue=true");
  if (readNestedString(postToolUse, ["hookSpecificOutput", "hookEventName"]) !== "PostToolUse")
    failures.push("Generated PostToolUse handler returned the wrong official result event");
  const stop = outputFor(input.invocations, CODEX_HOOK_REGISTRATIONS[3]!.id);
  if (!stop || Object.keys(stop).length !== 0)
    failures.push("Stop callback did not return the official empty completion result");

  let capturedPreToolUse: string | null = null;
  try {
    capturedPreToolUse = decoder.decode(readFile(input.filesystem, PRE_TOOL_USE_CAPTURE_PATH));
  } catch (error) {
    failures.push(`PreToolUse command did not save its stdin: ${String(error)}`);
  }
  const preInvocations = input.invocations.filter(
    (record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id,
  );
  if (
    capturedPreToolUse !==
    preInvocations.map((record) => `${JSON.stringify(record.input)}\n`).join("")
  )
    failures.push("PreToolUse command stdin did not preserve the official JSON payload");

  const generatedCalls = input.generatedCalls.filter(
    (call) => call.id === CODEX_POST_TOOL_USE_PROGRAM.id,
  );
  const postInvocations = input.invocations.filter((record) => record.event === "post-tool-use");
  if (
    generatedCalls.length !== expectedInvocations["post-tool-use"] ||
    generatedCalls.some(
      (call, index) =>
        readRecord(call.input)?.hook_event_name !== "PostToolUse" ||
        JSON.stringify(call.input) !== JSON.stringify(postInvocations[index]?.input),
    )
  )
    failures.push("PostToolUse event JSON did not reach the NodeGeneratedCode child");

  const rpcEvents = input.signalboxCalls.map(({ request }) => request.event).sort();
  if (rpcEvents.join(",") !== "session-start,stop")
    failures.push("Signalbox callback did not receive SessionStart and Stop");
  if (
    input.signalboxCalls.some(
      ({ request }) => request.sessionId !== readRecord(request.payload)?.session_id,
    )
  )
    failures.push("Signalbox callback sessionId differs from the official payload");
  const isolateCall = input.isolateCalls[0];
  if (
    input.isolateCalls.length !== expectedInvocations["pre-tool-use"] ||
    isolateCall?.executable !== "/bin/bash" ||
    input.isolateCalls.some((call) => call.executable !== "/bin/bash" || !successfulExit(call.exit))
  )
    failures.push("PreToolUse command did not use ComputerCommands.isolate.exec");
  if (input.machineAttempts.length !== 0)
    failures.push("A hook command attempted machine execution");

  const officialHookSpawns = input.spawnCalls.filter(isOfficialHookCommandSpawn);
  const expectedNativeShell = CODEX_NATIVE_HOOK_SHELL;
  if (officialHookSpawns.length !== expectedInvocationCount)
    failures.push("Codex did not launch each registered hook through its native command runner");
  if (officialHookSpawns.some(({ executable }) => executable !== expectedNativeShell))
    failures.push("Codex's native hook command runner did not use the selected Bash path");

  const hookResolve = input.host.resolve(CODEX_HOOK_EXECUTABLE);
  if (hookResolve.status !== "ok") failures.push("Kernel hook executable was not registered");
  if (hookFile.size !== executableFacade.byteLength || hookFile.mode !== 0o755)
    failures.push("Kernel hook executable facade is missing bytes or mode 0755");
  if (settingsText !== codexHookRequirements())
    failures.push("Managed Codex requirements differ from the fixture registrations");
  for (const id of expectedIds) {
    if (!settingsText.includes(id)) failures.push(`Codex requirements omit registration ${id}`);
  }
  const parentInfo = input.host.processes.info(input.parent);
  if (parentInfo.status !== "ok") failures.push("Codex engine has no admitted process handle");

  return {
    ok: failures.length === 0,
    failures,
    officialEvents: events,
    invocations: input.invocations,
    registrations: CODEX_HOOK_REGISTRATIONS.map(({ id, event }) => ({
      id,
      event,
      kind: CODEX_HOOK_MODES[event],
    })),
    preservedInput: {
      preToolUse: capturedPreToolUse,
      signalboxEvents: input.signalboxCalls.map(({ request }) => ({
        event: request.event,
        payload: request.payload,
      })),
      generatedPostToolUse: generatedCalls.map((call) => call.input),
    },
    outputDecisions: {
      sessionStart,
      preToolUse,
      postToolUse,
      stop,
    },
    isolateCalls: input.isolateCalls,
    generatedCalls: input.generatedCalls,
    signalboxCalls: input.signalboxCalls,
    officialSpawnCalls: input.spawnCalls,
    officialHookShell: {
      selectedBy: "Codex hook command runner using the proof SHELL path",
      expectedExecutable: expectedNativeShell,
      observedExecutables: officialHookSpawns.map(({ executable }) => executable),
      calls: officialHookSpawns,
    },
    machineAttempts: input.machineAttempts,
    executableFacade: hookFile,
    requirementsPath: CODEX_HOOK_REQUIREMENTS_PATH,
    engineProcessPid: parentInfo.status === "ok" ? parentInfo.value.pid : null,
    runtimeBoundary:
      "Interim: Bash runs through the in-facet program binding. The parent owns child Worker integration.",
    timings: {
      clock: "performance.now()",
      note: "A null elapsedMs means the host clock was unavailable or did not advance during the call.",
      perEvent: events.map(({ event, kind, elapsedMs, timingUnavailableReason }) => ({
        event,
        kind,
        elapsedMs,
        timingUnavailableReason,
      })),
      isolateCommands: input.isolateCalls.map(({ elapsedMs, timingUnavailableReason }) => ({
        elapsedMs,
        timingUnavailableReason: timingUnavailableReason ?? null,
      })),
      generatedCalls: input.generatedCalls.map(({ elapsedMs, timingUnavailableReason }) => ({
        elapsedMs,
        timingUnavailableReason: timingUnavailableReason ?? null,
      })),
    },
  };
}

function isOfficialHookCommandSpawn(call: SpawnCallRecord): boolean {
  const args = call.argv.join("\n");
  return (
    args.includes(CODEX_HOOK_EXECUTABLE) &&
    CODEX_HOOK_REGISTRATIONS.some(({ id }) => args.includes(id))
  );
}

function inspectFile(filesystem: KernelFileSystem, path: string) {
  try {
    const stat = filesystem.stat(path);
    return {
      exists: stat.type === "file",
      size: Number(stat.size),
      mode: filesystem.getPosixMetadata(path).mode & 0o777,
      text: stat.size <= 1_048_576 ? decoder.decode(readFile(filesystem, path)) : null,
    };
  } catch {
    return { exists: false, size: 0, mode: 0, text: null };
  }
}

function readFile(filesystem: KernelFileSystem, path: string): Uint8Array {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const size = filesystem.fstat(fd).size;
    if (size < 0n || size > 1_048_576n) throw new Error(`Unexpected file size for ${path}`);
    const output = new Uint8Array(Number(size));
    let offset = 0;
    while (offset < output.byteLength) {
      const count = filesystem.read(fd, output.subarray(offset), null);
      if (count === 0) throw new Error(`Unexpected end of file: ${path}`);
      offset += count;
    }
    return output;
  } finally {
    filesystem.close(fd);
  }
}

function outputFor(
  invocations: readonly HookInvocationRecord[],
  id: string,
): Record<string, unknown> | null {
  return parseObject(invocations.find((invocation) => invocation.id === id)?.stdout);
}

function successfulExit(exit: KernelCommandExit | undefined | null): boolean {
  return exit?.exitCode === 0 && exit.signal === 0 && !exit.coreDumped;
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return readRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedString(
  value: Record<string, unknown> | null,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) current = readRecord(current)?.[key];
  return typeof current === "string" ? current : undefined;
}
