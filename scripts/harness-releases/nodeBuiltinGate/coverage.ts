export interface NodeBuiltinAmbiguity {
  readonly kind: string;
  readonly module: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
}

export type NodeBuiltinFunctionStatus =
  | "supported"
  | "unsupported"
  | "missing"
  | "platform-pruned"
  | "conditional"
  | "unknown";

export interface NodeBuiltinFunctionCapability {
  readonly specifier: string;
  readonly memberPath: readonly string[];
  readonly status: NodeBuiltinFunctionStatus;
  readonly evidence: string;
}

export interface NodeBuiltinFunctionCall {
  readonly specifier: string;
  readonly memberPath: readonly string[];
  readonly module: string;
  readonly line: number;
  readonly column: number;
}

export interface NodeBuiltinCoverageInput {
  /** Node's builtins for the runtime version used to compile the release. */
  readonly builtinModules: readonly string[];
  /** Literal imports, exports, requires, and dynamic imports found in source. */
  readonly requiredSpecifiers: readonly string[];
  /** Keys from the actual module record installed by the public Node personality. */
  readonly installedSpecifiers: readonly string[];
  /** Computed imports that the literal source scan cannot resolve. */
  readonly ambiguities?: readonly NodeBuiltinAmbiguity[];
  /** Calls whose receiver is a statically resolved builtin export. */
  readonly requiredFunctions?: readonly NodeBuiltinFunctionCall[];
  /** Callable semantics taken from the constructed public Node personality. */
  readonly functionCapabilities?: readonly NodeBuiltinFunctionCapability[];
  /** Computed builtin members that are called but cannot be resolved statically. */
  readonly functionAmbiguities?: readonly NodeBuiltinAmbiguity[];
}

export interface NodeBuiltinCoverageReport {
  readonly schemaVersion: 1;
  readonly scope: "literal-imports-and-static-function-calls";
  readonly functionCallScope: "static-direct-calls";
  readonly status: "pass" | "fail";
  readonly requiredBuiltins: readonly string[];
  readonly installedBuiltins: readonly string[];
  readonly missingBuiltins: readonly string[];
  readonly unknownBuiltinSpecifiers: readonly string[];
  readonly ambiguities: readonly NodeBuiltinAmbiguity[];
  readonly requiredFunctions: readonly (NodeBuiltinFunctionCall & {
    readonly status: NodeBuiltinFunctionStatus;
    readonly evidence: string;
  })[];
  readonly functionAmbiguities: readonly (NodeBuiltinAmbiguity & {
    readonly severity: "warning" | "error";
  })[];
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function canonicalSpecifier(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function builtinCatalog(names: readonly string[]): Set<string> {
  return new Set(names.map(canonicalSpecifier));
}

/** Compare literal source imports with installed module keys, never routing metadata. */
export function inspectNodeBuiltinCoverage(
  input: NodeBuiltinCoverageInput,
): NodeBuiltinCoverageReport {
  const known = builtinCatalog(input.builtinModules);
  const required = new Set<string>();
  const installed = new Set<string>();
  const unknown = new Set<string>();

  for (const specifier of input.requiredSpecifiers) {
    const canonical = canonicalSpecifier(specifier);
    if (known.has(canonical)) required.add(canonical);
    else unknown.add(specifier);
  }

  for (const specifier of input.installedSpecifiers) {
    const canonical = canonicalSpecifier(specifier);
    if (known.has(canonical)) installed.add(canonical);
    else if (specifier.startsWith("node:")) unknown.add(specifier);
  }

  const requiredBuiltins = [...required].sort(compare);
  const installedBuiltins = [...installed].sort(compare);
  const missingBuiltins = requiredBuiltins.filter((name) => !installed.has(name));
  const unknownBuiltinSpecifiers = [...unknown].sort(compare);
  const ambiguities = [...(input.ambiguities ?? [])].sort(
    (left, right) =>
      compare(left.module, right.module) ||
      left.line - right.line ||
      left.column - right.column ||
      compare(left.kind, right.kind),
  );

  const capabilityByKey = new Map<string, NodeBuiltinFunctionCapability>();
  const duplicateCapabilityKeys = new Set<string>();
  for (const capability of input.functionCapabilities ?? []) {
    const key = JSON.stringify([
      canonicalSpecifier(capability.specifier),
      [...capability.memberPath],
    ]);
    if (capabilityByKey.has(key)) duplicateCapabilityKeys.add(key);
    else capabilityByKey.set(key, capability);
  }
  const requiredFunctions = [...(input.requiredFunctions ?? [])]
    .map((call) => {
      const specifier = canonicalSpecifier(call.specifier);
      const key = JSON.stringify([specifier, [...call.memberPath]]);
      const capability = capabilityByKey.get(key);
      const status: NodeBuiltinFunctionStatus = !known.has(specifier)
        ? "unknown"
        : !installed.has(specifier)
          ? "missing"
          : duplicateCapabilityKeys.has(key)
            ? "unknown"
            : (capability?.status ?? "unknown");
      const evidence = !known.has(specifier)
        ? `unknown builtin ${call.specifier}`
        : !installed.has(specifier)
          ? `${specifier} is absent from the constructed public Node personality`
          : duplicateCapabilityKeys.has(key)
            ? "conflicting runtime capability records"
            : (capability?.evidence ?? "runtime inventory has no evidence for this function");
      return { ...call, specifier, status, evidence };
    })
    .sort(
      (left, right) =>
        compare(left.specifier, right.specifier) ||
        compare(left.memberPath.join("."), right.memberPath.join(".")) ||
        compare(left.module, right.module) ||
        left.line - right.line ||
        left.column - right.column,
    );
  const functionAmbiguities = [...(input.functionAmbiguities ?? [])]
    .map((ambiguity) => ({
      ...ambiguity,
      severity:
        ambiguity.kind === "dynamic-builtin-member-call"
          ? ("warning" as const)
          : ("error" as const),
    }))
    .sort(
      (left, right) =>
        compare(left.module, right.module) ||
        left.line - right.line ||
        left.column - right.column ||
        compare(left.kind, right.kind),
    );

  return {
    schemaVersion: 1,
    scope: "literal-imports-and-static-function-calls",
    functionCallScope: "static-direct-calls",
    status:
      missingBuiltins.length ||
      unknownBuiltinSpecifiers.length ||
      requiredFunctions.some(
        (call) => call.status !== "supported" && call.status !== "platform-pruned",
      ) ||
      functionAmbiguities.some((ambiguity) => ambiguity.severity === "error")
        ? "fail"
        : "pass",
    requiredBuiltins,
    installedBuiltins,
    missingBuiltins,
    unknownBuiltinSpecifiers,
    ambiguities,
    requiredFunctions,
    functionAmbiguities,
  };
}

export function assertNodeBuiltinCoverage(report: NodeBuiltinCoverageReport): void {
  if (report.status === "pass") return;
  const blockingAmbiguities = report.functionAmbiguities.filter(
    (ambiguity) => ambiguity.severity === "error",
  );
  const details = [
    report.missingBuiltins.length ? `missing=${report.missingBuiltins.join(",")}` : undefined,
    report.unknownBuiltinSpecifiers.length
      ? `unknown=${report.unknownBuiltinSpecifiers.join(",")}`
      : undefined,
    ...(["unsupported", "missing", "conditional", "unknown"] as const).map((status) => {
      const calls = report.requiredFunctions.filter((call) => call.status === status);
      if (!calls.length) return undefined;
      return `${status}-functions=${calls
        .map(
          (call) =>
            `${call.specifier}.${call.memberPath.join(".") || "<default>"}@${call.module}:${call.line}:${call.column} (${call.evidence})`,
        )
        .join(",")}`;
    }),
    blockingAmbiguities.length
      ? `unresolved-function-calls=${blockingAmbiguities
          .map((call) => `${call.kind}@${call.module}:${call.line}:${call.column}`)
          .join(",")}`
      : undefined,
  ].filter(Boolean);
  throw new Error(`NODE_BUILTIN_COVERAGE_FAILED: ${details.join(" ")}`);
}
