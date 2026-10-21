export interface NodeBuiltinAmbiguity {
  readonly kind: string;
  readonly module: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
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
}

export interface NodeBuiltinCoverageReport {
  readonly schemaVersion: 1;
  readonly scope: "literal-imports";
  readonly status: "pass" | "fail";
  readonly requiredBuiltins: readonly string[];
  readonly installedBuiltins: readonly string[];
  readonly missingBuiltins: readonly string[];
  readonly unknownBuiltinSpecifiers: readonly string[];
  readonly ambiguities: readonly NodeBuiltinAmbiguity[];
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function canonicalSpecifier(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function builtinCatalog(names: readonly string[]): Set<string> {
  return new Set(names.map(canonicalSpecifier));
}

/** Get builtin names from actual module objects, including NodeBridge's fs.promises alias. */
export function nodeBuiltinProviderSpecifiers(
  modules: Readonly<Record<string, unknown>>,
  builtinModules: readonly string[],
): readonly string[] {
  const known = builtinCatalog(builtinModules);
  const names = new Set<string>();
  for (const [specifier, value] of Object.entries(modules)) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
    const canonical = canonicalSpecifier(specifier);
    if (known.has(canonical) || specifier.startsWith("node:")) names.add(specifier);
  }

  const fs = modules.fs ?? modules["node:fs"];
  if (fs !== null && (typeof fs === "object" || typeof fs === "function")) {
    const promises = Reflect.get(fs, "promises");
    if (promises !== null && (typeof promises === "object" || typeof promises === "function"))
      names.add("fs/promises");
  }

  return [...names].sort(compare);
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

  return {
    schemaVersion: 1,
    scope: "literal-imports",
    status: missingBuiltins.length || unknownBuiltinSpecifiers.length ? "fail" : "pass",
    requiredBuiltins,
    installedBuiltins,
    missingBuiltins,
    unknownBuiltinSpecifiers,
    ambiguities,
  };
}

export function assertNodeBuiltinCoverage(report: NodeBuiltinCoverageReport): void {
  if (report.status === "pass") return;
  const details = [
    report.missingBuiltins.length ? `missing=${report.missingBuiltins.join(",")}` : undefined,
    report.unknownBuiltinSpecifiers.length
      ? `unknown=${report.unknownBuiltinSpecifiers.join(",")}`
      : undefined,
  ].filter(Boolean);
  throw new Error(`NODE_BUILTIN_COVERAGE_FAILED: ${details.join(" ")}`);
}
