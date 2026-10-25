import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type {
  NodeBuiltinFunctionCall,
  NodeBuiltinFunctionCapability,
  NodeBuiltinFunctionStatus,
} from "./nodeBuiltinGate/coverage.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface RuntimeBuiltinInventory {
  readonly modules: readonly string[];
  readonly functions: readonly NodeBuiltinFunctionCapability[];
  readonly profile: RuntimeBuiltinTargetProfile;
  readonly capture?: Readonly<Record<string, unknown>>;
}

export interface RuntimeBuiltinTargetProfile {
  readonly nativeRuntime?: {
    readonly runtime: string;
    readonly workerdVersion: string;
    readonly nodeCompatibilityRevision: string;
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  };
  readonly systemIdentity: Readonly<Record<string, unknown>>;
  readonly processIdentity: Readonly<Record<string, unknown>>;
  readonly filesystem: {
    readonly posixPolicy: boolean;
    readonly setUmask: boolean;
  };
  readonly cpu: {
    readonly execution: boolean;
    readonly processAccounting: boolean;
  };
}

const functionStatuses = new Set<NodeBuiltinFunctionStatus>([
  "supported",
  "unsupported",
  "missing",
  "platform-pruned",
  "conditional",
  "unknown",
]);

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isMemberPath(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((member: unknown) => typeof member === "string" && member.length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeBuiltinTargetProfile(value: unknown): RuntimeBuiltinTargetProfile {
  if (!isRecord(value)) throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  const systemIdentity = Reflect.get(value, "systemIdentity");
  const processIdentity = Reflect.get(value, "processIdentity");
  const filesystem = Reflect.get(value, "filesystem");
  const cpu = Reflect.get(value, "cpu");
  const rawNativeRuntime = Reflect.get(value, "nativeRuntime");
  if (
    !isRecord(systemIdentity) ||
    !isRecord(processIdentity) ||
    !isRecord(filesystem) ||
    !isRecord(cpu)
  )
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  let nativeRuntime: RuntimeBuiltinTargetProfile["nativeRuntime"];
  if (rawNativeRuntime !== undefined) {
    if (
      !isRecord(rawNativeRuntime) ||
      typeof rawNativeRuntime.runtime !== "string" ||
      typeof rawNativeRuntime.workerdVersion !== "string" ||
      typeof rawNativeRuntime.nodeCompatibilityRevision !== "string" ||
      typeof rawNativeRuntime.compatibilityDate !== "string" ||
      !isStringArray(rawNativeRuntime.compatibilityFlags)
    )
      throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
    nativeRuntime = {
      runtime: rawNativeRuntime.runtime,
      workerdVersion: rawNativeRuntime.workerdVersion,
      nodeCompatibilityRevision: rawNativeRuntime.nodeCompatibilityRevision,
      compatibilityDate: rawNativeRuntime.compatibilityDate,
      compatibilityFlags: rawNativeRuntime.compatibilityFlags,
    };
  }
  const posixPolicy = Reflect.get(filesystem, "posixPolicy");
  const setUmask = Reflect.get(filesystem, "setUmask");
  const execution = Reflect.get(cpu, "execution");
  const processAccounting = Reflect.get(cpu, "processAccounting");
  if (
    typeof posixPolicy !== "boolean" ||
    typeof setUmask !== "boolean" ||
    typeof execution !== "boolean" ||
    typeof processAccounting !== "boolean"
  )
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  return {
    ...(nativeRuntime === undefined ? {} : { nativeRuntime }),
    systemIdentity,
    processIdentity,
    filesystem: { posixPolicy, setUmask },
    cpu: { execution, processAccounting },
  };
}

function parseRuntimeBuiltinInventory(value: unknown): RuntimeBuiltinInventory {
  if (!value || typeof value !== "object")
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  const modules = Reflect.get(value, "modules");
  const functions = Reflect.get(value, "functions");
  const profile = parseRuntimeBuiltinTargetProfile(Reflect.get(value, "profile"));
  if (!isStringArray(modules) || !Array.isArray(functions))
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  const capabilities: NodeBuiltinFunctionCapability[] = [];
  for (const functionRecord of functions) {
    if (!functionRecord || typeof functionRecord !== "object")
      throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
    const specifier = Reflect.get(functionRecord, "specifier");
    const memberPath = Reflect.get(functionRecord, "memberPath");
    const status = Reflect.get(functionRecord, "status");
    const evidence = Reflect.get(functionRecord, "evidence");
    if (
      typeof specifier !== "string" ||
      !specifier ||
      !isMemberPath(memberPath) ||
      typeof status !== "string" ||
      !functionStatuses.has(status as NodeBuiltinFunctionStatus) ||
      typeof evidence !== "string" ||
      !evidence
    )
      throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
    capabilities.push({
      specifier,
      memberPath,
      status: status as NodeBuiltinFunctionStatus,
      evidence,
    });
  }
  const capture = Reflect.get(value, "capture");
  if (capture !== undefined && !isRecord(capture))
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  return { modules, functions: capabilities, profile, ...(capture ? { capture } : {}) };
}

/** The cloud CLI inspects the public personality inside Workerd, then closes the runtime. */
export async function captureRuntimeBuiltinInventory(
  requiredFunctions: readonly NodeBuiltinFunctionCall[] = [],
): Promise<RuntimeBuiltinInventory> {
  const requests = new Map<string, { specifier: string; memberPath: readonly string[] }>();
  for (const { specifier, memberPath } of requiredFunctions) {
    const canonical = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
    requests.set(JSON.stringify([canonical, memberPath]), { specifier, memberPath });
  }
  const entry = NodeURL.fileURLToPath(
    new URL("../../apps/cloud/infra/harnessReleases/runtimeBuiltinInventory.ts", import.meta.url),
  );
  const { stdout } = await execFile(
    process.execPath,
    [entry, JSON.stringify([...requests.values()])],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      env: Object.fromEntries(
        ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
          .flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))
          .concat([
            ["WRANGLER_SEND_METRICS", "false"],
            ["CI", "1"],
          ]),
      ),
    },
  );
  return parseRuntimeBuiltinInventory(JSON.parse(stdout));
}

/** Compatibility projection for callers that only need the installed module names. */
export async function captureRuntimeBuiltinSpecifiers(): Promise<readonly string[]> {
  return (await captureRuntimeBuiltinInventory()).modules;
}
