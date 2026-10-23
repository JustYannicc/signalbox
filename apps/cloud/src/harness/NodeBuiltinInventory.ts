import { createNodeBridge, type NodeBridge } from "../isolate/NodeBridge.ts";
import { canonicalNodeBuiltin } from "../isolate/NodeBuiltinMap.ts";
import { getNodeBuiltinCapability } from "../isolate/NodeBuiltinCapabilities.ts";
import { systemIdentityForThread, type SystemIdentity } from "@t3tools/contracts/systemIdentity";
import { createHarnessRuntime } from "./node/runtime.ts";
import type { NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import {
  classifyNodeNativeBuiltinCapability,
  type NodeNativeRuntimeProfile,
} from "./NodeNativeBuiltinCapabilities.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "./node/nativeModules.ts";

export type NodeBuiltinFunctionStatus =
  | "supported"
  | "unsupported"
  | "missing"
  | "platform-pruned"
  | "conditional"
  | "unknown";

export interface NodeBuiltinFunctionRequest {
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

export interface NodeBuiltinFunctionCapability extends NodeBuiltinFunctionRequest {
  readonly status: NodeBuiltinFunctionStatus;
  readonly evidence: string;
}

export interface NodeBuiltinTargetProfile {
  readonly nativeRuntime?: NodeNativeRuntimeProfile;
  readonly systemIdentity: SystemIdentity;
  readonly processIdentity: NodeHarnessProcessInput["identity"];
  readonly filesystem: {
    readonly posixPolicy: boolean;
    readonly setUmask: boolean;
  };
  readonly cpu: {
    readonly execution: boolean;
    readonly processAccounting: boolean;
  };
}

type PropertyResult =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | { readonly kind: "unknown" }
  | { readonly kind: "value"; readonly value: unknown };

function readProperty(target: unknown, name: string): PropertyResult {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") {
    return { kind: "missing" };
  }

  let current: object | null = target;
  const visited = new Set<object>();
  try {
    while (current !== null) {
      if (visited.has(current)) return { kind: "unknown" };
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        return "value" in descriptor
          ? { kind: "value", value: descriptor.value }
          : { kind: "accessor" };
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return { kind: "unknown" };
  }
  return { kind: "missing" };
}

function lookupBuiltinModule(
  modules: Readonly<Record<string, object>>,
  specifier: string,
):
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" }
  | { readonly kind: "found"; readonly value: object } {
  const canonical = canonicalNodeBuiltin(specifier);
  if (!canonical) return { kind: "unknown" };

  let found: object | undefined;
  for (const [name, value] of Object.entries(modules)) {
    if (canonicalNodeBuiltin(name) !== canonical) continue;
    if (found !== undefined && found !== value) return { kind: "unknown" };
    found = value;
  }
  return found === undefined ? { kind: "missing" } : { kind: "found", value: found };
}

function classifyNonTtyStdinRawModeAbsence(
  specifier: string,
  memberPath: readonly string[],
  processModule: object,
): NodeBuiltinFunctionCapability | undefined {
  if (
    canonicalNodeBuiltin(specifier) !== "process" ||
    memberPath.length !== 2 ||
    memberPath[0] !== "stdin" ||
    memberPath[1] !== "setRawMode"
  ) {
    return undefined;
  }
  const stdin = readProperty(processModule, "stdin");
  if (stdin.kind !== "value") return undefined;
  const isTTY = readProperty(stdin.value, "isTTY");
  if (isTTY.kind !== "value" || isTTY.value !== false) return undefined;
  return {
    specifier,
    memberPath,
    status: "platform-pruned",
    evidence:
      "The constructed process profile exposes stdin.isTTY=false on its kernel-backed pipe; Node exposes setRawMode only for TTY input",
  };
}

/** Classifies static calls by inspecting actual public module objects without invoking them. */
export function inspectNodeBuiltinFunctionCapabilities(
  modules: Readonly<Record<string, object>>,
  requests: readonly NodeBuiltinFunctionRequest[],
  profile?: NodeBuiltinTargetProfile,
): readonly NodeBuiltinFunctionCapability[] {
  const capabilities = requests.map(({ specifier, memberPath }): NodeBuiltinFunctionCapability => {
    const module = lookupBuiltinModule(modules, specifier);
    if (module.kind === "unknown") {
      return {
        specifier,
        memberPath,
        status: "unknown",
        evidence: `Unknown or conflicting Node builtin module: ${specifier}`,
      };
    }
    if (module.kind === "missing") {
      return {
        specifier,
        memberPath,
        status: "missing",
        evidence: `${specifier} is absent from the constructed public Node personality`,
      };
    }

    let value: unknown = module.value;
    for (const segment of memberPath) {
      const property = readProperty(value, segment);
      if (property.kind === "unknown") {
        return {
          specifier,
          memberPath,
          status: "unknown",
          evidence: `${specifier}.${memberPath.join(".")} could not be inspected safely`,
        };
      }
      if (property.kind === "accessor") {
        return {
          specifier,
          memberPath,
          status: "unknown",
          evidence: `${specifier}.${memberPath.join(".")} crosses an accessor that was not invoked`,
        };
      }
      if (property.kind === "missing") {
        const expectedAbsence = classifyNonTtyStdinRawModeAbsence(
          specifier,
          memberPath,
          module.value,
        );
        if (expectedAbsence) return expectedAbsence;
        return {
          specifier,
          memberPath,
          status: "missing",
          evidence: `${specifier}.${memberPath.join(".")} is absent from the constructed public Node personality`,
        };
      }
      value = property.value;
    }

    if (typeof value !== "function") {
      return {
        specifier,
        memberPath,
        // Existence guards must not make present non-callable values pass publication.
        status: value === undefined ? "missing" : "unsupported",
        evidence: `${specifier}.${memberPath.join(".") || "<module>"} exists but is not callable`,
      };
    }

    const capability =
      getNodeBuiltinCapability(value) ??
      classifyNodeNativeBuiltinCapability({
        modules,
        auditedDefaultModules: DEFAULT_NODE_NATIVE_MODULES,
        request: { specifier, memberPath },
        ...(profile?.nativeRuntime ? { runtimeProfile: profile.nativeRuntime } : {}),
      });
    return capability
      ? { specifier, memberPath, ...capability }
      : {
          specifier,
          memberPath,
          status: "unknown",
          evidence: `${specifier}.${memberPath.join(".")} is callable but has no explicit capability declaration`,
        };
  });
  return profile === undefined
    ? capabilities
    : applySelectedTargetCapabilities(capabilities, profile);
}

function applySelectedTargetCapabilities(
  capabilities: readonly NodeBuiltinFunctionCapability[],
  profile: NodeBuiltinTargetProfile,
): readonly NodeBuiltinFunctionCapability[] {
  return capabilities.map((capability): NodeBuiltinFunctionCapability => {
    if (capability.specifier !== "process") return capability;
    if (
      capability.memberPath.length === 1 &&
      capability.memberPath[0] === "umask" &&
      (!profile.filesystem.posixPolicy || !profile.filesystem.setUmask)
    ) {
      return {
        ...capability,
        status: "unsupported",
        evidence:
          "Selected inventory profile lacks KernelFileSystem.posixPolicy or KernelFileSystem.setUmask",
      };
    }
    return capability;
  });
}

/** Constructs production module objects without installing a personality or loading a release. */
export function createHarnessNodeBuiltinInventory(
  input: NodeHarnessProcessInput,
  signal: AbortSignal,
  nativeRuntime?: NodeNativeRuntimeProfile,
) {
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  let bridge: NodeBridge | undefined;
  try {
    const systemIdentity = input.systemIdentity ?? systemIdentityForThread(input.computer.threadId);
    const runtime = createHarnessRuntime(
      { ...input, systemIdentity },
      { lifetime: combined, stdin: combined, output: combined },
      () => {
        throw new Error("Builtin inventory must not launch a child process");
      },
      (): NodeBridge => (bridge ??= createNodeBridge(runtime.modules)),
    );
    const profile: NodeBuiltinTargetProfile = {
      ...(nativeRuntime ? { nativeRuntime } : {}),
      systemIdentity,
      processIdentity: input.identity,
      filesystem: {
        posixPolicy: input.computer.files.posixPolicy !== undefined,
        setUmask: typeof input.computer.files.setUmask === "function",
      },
      cpu: {
        execution: input.host.cpuExecution !== undefined,
        processAccounting: runtime.cpu !== undefined,
      },
    };
    let disposed: Promise<void> | undefined;
    return {
      modules: runtime.modules,
      profile,
      dispose() {
        disposed ??= (async () => {
          lifetime.abort();
          const closing = Object.values(runtime.streams).map(
            (stream) =>
              new Promise<void>((resolve) => {
                if (stream.closed) return resolve();
                // Destruction can deliver a pending read's cancellation error before close.
                const onError = () => {};
                stream.on("error", onError);
                stream.once("close", () => {
                  stream.removeListener("error", onError);
                  resolve();
                });
                stream.destroy();
              }),
          );
          const results = await Promise.allSettled([...closing, runtime.drainDns()]);
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length > 0)
            throw new AggregateError(errors, "Builtin inventory cleanup failed");
        })();
        return disposed;
      },
    };
  } catch (error) {
    lifetime.abort();
    throw error;
  }
}
