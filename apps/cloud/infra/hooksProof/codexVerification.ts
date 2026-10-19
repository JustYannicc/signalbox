import { HOOK_PROGRAM_FACADE } from "./hookProgramFacade.ts";
import type { HookExecutionResult } from "../../src/hooks/HookService.ts";
import type { HarnessHookJson, HarnessHookRequest } from "../../src/hooks/HarnessHooks.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { KernelHandle } from "../../src/kernel/KernelAbi.ts";
import type { KernelCommandExit } from "../../src/kernel/KernelCommandForwarder.ts";
import type { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { NodeGeneratedCodeInvokeInput } from "../../src/isolate/NodeGeneratedCode.ts";
import { STANDARD_PROOF_NAMED_SECRET } from "./standardProofAdapter.ts";
import {
  CODEX_STANDARD_DISPATCH_IDS,
  redactCodexProofText,
  redactCodexProofValue,
  verifyCodexHookPayloads,
  verifyCodexStandardHookPayloads,
  verifyCodexStandardHookResults,
  type CodexStandardHookInspection,
} from "./codexPayloads.ts";
import {
  CODEX_ALL_HOOK_REGISTRATIONS,
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_REGISTRATIONS,
  CODEX_HOOK_REQUIREMENTS_PATH,
  CODEX_NATIVE_HOOK_SHELL,
  CODEX_POST_TOOL_USE_PROGRAM,
  CODEX_STANDARD_HOOK_REGISTRATIONS,
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
export type CodexHookKind = (typeof CODEX_ALL_HOOK_REGISTRATIONS)[number]["kind"];

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
  readonly standard: CodexStandardHookInspection;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const executableFacade = encoder.encode(HOOK_PROGRAM_FACADE);

/** Checks official event results and the process paths the unchanged CLI actually used. */
export async function verifyCodexHooks(input: CodexHookVerificationInput) {
  const originalIds = new Set<string>(CODEX_HOOK_REGISTRATIONS.map(({ id }) => id));
  const originalInvocations = input.invocations.filter((record) => originalIds.has(record.id));
  const standardIds = new Set<string>(CODEX_STANDARD_HOOK_REGISTRATIONS.map(({ id }) => id));
  const standardInvocations = input.invocations.filter((record) => standardIds.has(record.id));
  const failures = [
    ...verifyCodexHookPayloads(input.invocations),
    ...verifyCodexStandardHookPayloads(input.invocations),
    ...verifyCodexStandardHookResults(input.invocations, input.standard),
  ];
  const hookFile = inspectFile(input.filesystem, CODEX_HOOK_EXECUTABLE);
  const settingsFile = inspectFile(input.filesystem, CODEX_HOOK_REQUIREMENTS_PATH);
  const settingsText = settingsFile.text ?? "";
  const expectedIds = CODEX_HOOK_REGISTRATIONS.map(({ id }) => id);
  const events = CODEX_HOOK_REGISTRATIONS.map(({ id, event }) => {
    const kind = CODEX_HOOK_MODES[event];
    const records = originalInvocations.filter((invocation) => invocation.id === id);
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
      stdout: record?.stdout === undefined ? null : redactCodexProofText(record.stdout),
      stderr: record?.stderr === undefined ? null : redactCodexProofText(record.stderr),
      error: record?.error === undefined ? null : redactCodexProofText(record.error),
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
  const expectedHookSpawnCount =
    expectedInvocationCount +
    CODEX_STANDARD_HOOK_REGISTRATIONS.reduce(
      (sum, { event }) => sum + expectedInvocations[event],
      0,
    );
  if (input.invocations.length !== expectedHookSpawnCount)
    failures.push(`Expected ${expectedHookSpawnCount} native hook invocations`);
  for (const record of originalInvocations) {
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
  for (const record of standardInvocations) {
    if (record.kind !== "signalbox")
      failures.push(`${record.id} was not classified as a Signalbox hook`);
    const result = parseObject(record.stdout);
    if (!result || Object.keys(result).length !== 0)
      failures.push(`${record.id} returned something other than the neutral standard result`);
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
  const postInvocations = originalInvocations.filter(
    (record) => record.id === CODEX_HOOK_REGISTRATIONS[2]!.id,
  );
  if (
    generatedCalls.length !== expectedInvocations["post-tool-use"] ||
    generatedCalls.some(
      (call, index) =>
        readRecord(call.input)?.hook_event_name !== "PostToolUse" ||
        JSON.stringify(call.input) !== JSON.stringify(postInvocations[index]?.input),
    )
  )
    failures.push("PostToolUse event JSON did not reach the NodeGeneratedCode child");

  const originalRpcEvents = input.signalboxCalls
    .map(({ request }) => request.event)
    .filter((event) => event === "session-start" || event === "stop")
    .sort();
  if (originalRpcEvents.join(",") !== "session-start,stop")
    failures.push("Signalbox callback did not receive SessionStart and Stop");
  const standardRpcEvents = input.signalboxCalls
    .map(({ request }) => request.event)
    .filter((event) => event === "pre-tool-use" || event === "post-tool-use")
    .sort();
  if (standardRpcEvents.join(",") !== "post-tool-use,post-tool-use,pre-tool-use,pre-tool-use")
    failures.push("Standard RPC hooks did not receive both native tool events");
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
  const expectedCommandStderr = "{{secret:API_TOKEN}}\n";
  const proofSecret = STANDARD_PROOF_NAMED_SECRET.value;
  const preCommandInvocations = originalInvocations.filter(
    (record) => record.id === CODEX_HOOK_REGISTRATIONS[1]!.id,
  );
  for (const record of preCommandInvocations) {
    if (record.stderr !== expectedCommandStderr)
      failures.push(`${record.id} did not scrub the command environment from stderr`);
    if (record.stdout?.includes(proofSecret) || record.stderr?.includes(proofSecret))
      failures.push(`${record.id} exposed a filled secret in hook output`);
  }
  if (input.machineAttempts.length !== 0)
    failures.push("A hook command attempted machine execution");

  const hookRunnerSpawns = input.spawnCalls.filter(({ argv }) =>
    argv.some((argument) => argument.includes(CODEX_HOOK_EXECUTABLE)),
  );
  const officialHookSpawns = input.spawnCalls.filter(isOfficialHookCommandSpawn);
  const expectedNativeShell = CODEX_NATIVE_HOOK_SHELL;
  if (hookRunnerSpawns.length !== expectedHookSpawnCount)
    failures.push(
      `Codex launched ${hookRunnerSpawns.length} hook processes instead of ${expectedHookSpawnCount}`,
    );
  if (officialHookSpawns.length !== expectedHookSpawnCount)
    failures.push(
      `Codex launched ${officialHookSpawns.length} native hook processes instead of ${expectedHookSpawnCount}`,
    );
  for (const { id, event } of CODEX_ALL_HOOK_REGISTRATIONS) {
    const count = hookRunnerSpawns.filter(({ argv }) => argv.join("\n").includes(id)).length;
    if (count !== expectedInvocations[event])
      failures.push(`${id} launched ${count} times instead of ${expectedInvocations[event]}`);
  }
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
  for (const { id } of CODEX_STANDARD_HOOK_REGISTRATIONS) {
    if (!settingsText.includes(id)) failures.push(`Codex requirements omit registration ${id}`);
  }
  const parentInfo = input.host.processes.info(input.parent);
  if (parentInfo.status !== "ok") failures.push("Codex engine has no admitted process handle");

  return {
    ok: failures.length === 0,
    failures,
    officialEvents: events,
    standardEvents: input.invocations
      .filter((record) => CODEX_STANDARD_DISPATCH_IDS.has(record.id))
      .map(({ id, event, kind, elapsedMs, timingUnavailableReason }) => ({
        id,
        event,
        kind,
        elapsedMs,
        timingUnavailableReason: timingUnavailableReason ?? null,
      })),
    invocations: input.invocations.map((record) => ({
      ...record,
      input: redactCodexProofValue(record.input),
      ...(record.stdout === undefined ? {} : { stdout: redactCodexProofText(record.stdout) }),
      ...(record.stderr === undefined ? {} : { stderr: redactCodexProofText(record.stderr) }),
      ...(record.error === undefined ? {} : { error: redactCodexProofText(record.error) }),
    })),
    registrations: CODEX_HOOK_REGISTRATIONS.map(({ id, event }) => ({
      id,
      event,
      kind: CODEX_HOOK_MODES[event],
    })),
    standardRegistrations: CODEX_STANDARD_HOOK_REGISTRATIONS,
    nativeFileFill: "unproved: this Codex fixture covers command-hook environment fill only",
    preservedInput: {
      preToolUse: capturedPreToolUse,
      signalboxEvents: redactCodexProofValue(
        input.signalboxCalls.map(({ request }) => ({
          event: request.event,
          payload: request.payload,
        })),
      ),
      generatedPostToolUse: redactCodexProofValue(generatedCalls.map((call) => call.input)),
    },
    outputDecisions: redactCodexProofValue({
      sessionStart,
      preToolUse,
      postToolUse,
      stop,
    }),
    isolateCalls: redactCodexProofValue(input.isolateCalls),
    generatedCalls: redactCodexProofValue(input.generatedCalls),
    signalboxCalls: redactCodexProofValue(input.signalboxCalls),
    officialSpawnCalls: redactCodexProofValue(input.spawnCalls),
    officialHookShell: {
      selectedBy: "Codex hook command runner using the proof SHELL path",
      expectedExecutable: expectedNativeShell,
      observedExecutables: officialHookSpawns.map(({ executable }) => executable),
      calls: redactCodexProofValue(officialHookSpawns),
    },
    machineAttempts: redactCodexProofValue(input.machineAttempts),
    executableFacade: hookFile,
    requirementsPath: CODEX_HOOK_REQUIREMENTS_PATH,
    engineProcessPid: parentInfo.status === "ok" ? parentInfo.value.pid : null,
    runtimeBoundary: "child-dynamic-workers",
    timings: {
      clock: "performance.now()",
      note: "A null elapsedMs means the host clock was unavailable or did not advance during the call.",
      perEvent: events.map(({ event, kind, elapsedMs, timingUnavailableReason }) => ({
        event,
        kind,
        elapsedMs,
        timingUnavailableReason,
      })),
      perInvocation: input.invocations.map(
        ({ id, event, kind, elapsedMs, timingUnavailableReason }) => ({
          id,
          event,
          kind,
          elapsedMs,
          timingUnavailableReason: timingUnavailableReason ?? null,
        }),
      ),
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
    CODEX_ALL_HOOK_REGISTRATIONS.some(({ id }) => args.includes(id))
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
