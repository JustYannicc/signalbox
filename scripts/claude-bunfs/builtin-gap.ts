import type { BunApiInventory } from "./bun-api-inventory.ts";
import type { BuiltinUse } from "./release-inventory-imports.ts";

export type BunCapabilityStatus = "implemented" | "host" | "headless" | "unsupported";

export interface NodeBuiltinCapability {
  readonly available: boolean;
  readonly defaultImport: boolean;
  readonly defaultMembers: ReadonlyArray<string>;
  readonly namespaceImport: boolean;
  readonly namedExports: ReadonlyArray<string>;
  readonly commonJs: boolean;
  readonly commonJsMembers: ReadonlyArray<string>;
}

/** Target runtime capabilities are input data; this scanner contains no release allowlist. */
export interface BuiltinCapabilityManifest {
  readonly bunApis: Readonly<Record<string, BunCapabilityStatus>>;
  readonly nodeBuiltinModules?: ReadonlyArray<string>;
  readonly nodeBuiltins: Readonly<Record<string, NodeBuiltinCapability>>;
  readonly providedHostPaths?: ReadonlyArray<string>;
  readonly featureOffPaths?: ReadonlyArray<string>;
  readonly escalationPaths?: ReadonlyArray<string>;
}

export interface BunCapabilityGap {
  readonly kind: "bun-api";
  readonly name: string;
  readonly module: string;
  readonly key?: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly reason:
    | "unmapped-api"
    | "dynamic-access"
    | "missing-host-binding"
    | "missing-feature-off-evidence"
    | "unguarded-unsupported-use";
  readonly status?: BunCapabilityStatus;
  readonly guarded: boolean;
}

export interface BuiltinGap {
  readonly kind: "node-builtin";
  readonly name: string;
  readonly specifier: string;
  readonly canonicalBuiltin: string;
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly reason:
    | "missing-module"
    | "missing-default"
    | "missing-namespace"
    | "missing-named-export"
    | "missing-commonjs"
    | "missing-commonjs-member"
    | "dynamic-member";
  readonly guarded: boolean;
}

export type ReleaseBuiltinGap = BunCapabilityGap | BuiltinGap;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gap(
  item: BuiltinUse,
  name: string,
  location: { readonly line: number; readonly column: number; readonly offset: number },
  reason: BuiltinGap["reason"],
  guarded = false,
): BuiltinGap {
  return {
    kind: "node-builtin",
    name,
    specifier: item.specifier,
    canonicalBuiltin: item.canonicalBuiltin,
    module: item.module,
    key: item.key,
    line: location.line,
    column: location.column,
    offset: location.offset,
    reason,
    guarded,
  };
}

/** Check imported builtin members against an explicit runtime capability contract. */
export function findNodeBuiltinGaps(
  builtins: ReadonlyArray<BuiltinUse>,
  capabilities: BuiltinCapabilityManifest,
): ReadonlyArray<BuiltinGap> {
  const gaps: BuiltinGap[] = [];
  for (const item of builtins) {
    const capability = capabilities.nodeBuiltins[item.canonicalBuiltin];
    if (!capability?.available) {
      const first = item.imports[0] ?? item.memberUses[0] ?? item.dynamicMemberUses[0];
      if (first) gaps.push(gap(item, item.canonicalBuiltin, first, "missing-module"));
      else
        gaps.push(
          gap(item, item.canonicalBuiltin, { line: 1, column: 1, offset: 0 }, "missing-module"),
        );
      continue;
    }
    for (const imported of item.imports) {
      if (imported.kind === "side-effect") continue;
      if (imported.kind === "default" && !capability.defaultImport)
        gaps.push(gap(item, "default", imported, "missing-default"));
      else if (imported.kind === "namespace" && !capability.namespaceImport)
        gaps.push(gap(item, "*", imported, "missing-namespace"));
      else if (imported.kind === "named" && !capability.namedExports.includes(imported.imported))
        gaps.push(gap(item, imported.imported, imported, "missing-named-export"));
      else if (imported.kind === "require" && !capability.commonJs)
        gaps.push(gap(item, imported.imported, imported, "missing-commonjs"));
      else if (
        imported.kind === "require" &&
        imported.imported !== "*" &&
        !capability.commonJsMembers.includes(imported.imported)
      )
        gaps.push(gap(item, imported.imported, imported, "missing-commonjs-member"));
    }
    for (const use of item.memberUses) {
      const supported =
        use.via === "namespace"
          ? capability.namedExports.includes(use.member)
          : use.via === "default"
            ? capability.defaultMembers.includes(use.member)
            : capability.commonJsMembers.includes(use.member);
      if (!supported)
        gaps.push(
          gap(
            item,
            use.member,
            use,
            use.via === "require" ? "missing-commonjs-member" : "missing-named-export",
            use.guarded,
          ),
        );
    }
    for (const use of item.dynamicMemberUses)
      gaps.push(gap(item, "<dynamic>", use, "dynamic-member", use.guarded));
  }
  return gaps.sort(
    (a, b) =>
      compare(a.module, b.module) ||
      a.offset - b.offset ||
      compare(a.name, b.name) ||
      compare(a.reason, b.reason),
  );
}

/** Check every exact Bun leaf; a namespace status never grants unlisted descendants. */
export function findBunCapabilityGaps(
  inventory: BunApiInventory,
  capabilities: BuiltinCapabilityManifest,
  moduleKeys: ReadonlyMap<string, string> = new Map(),
  guardedLocations: ReadonlySet<string> = new Set(),
): ReadonlyArray<BunCapabilityGap> {
  const gaps: BunCapabilityGap[] = [];
  const hosts = new Set(capabilities.providedHostPaths ?? []);
  const featureOff = new Set(capabilities.featureOffPaths ?? []);
  const escalations = new Set(capabilities.escalationPaths ?? []);
  for (const member of inventory.members) {
    const status = capabilities.bunApis[member.path];
    for (const occurrence of member.occurrences) {
      const guarded = guardedLocations.has(`${occurrence.module}\0${occurrence.offset}`);
      let reason: BunCapabilityGap["reason"] | undefined;
      if (!status) reason = "unmapped-api";
      else if (status === "host" && !hosts.has(member.path)) reason = "missing-host-binding";
      else if (
        (status === "headless" || status === "unsupported") &&
        !featureOff.has(member.path) &&
        !escalations.has(member.path)
      )
        reason = "missing-feature-off-evidence";
      else if ((status === "headless" || status === "unsupported") && !guarded)
        reason = "unguarded-unsupported-use";
      if (reason)
        gaps.push({
          kind: "bun-api",
          name: member.path,
          module: occurrence.module,
          ...(moduleKeys.has(occurrence.module) ? { key: moduleKeys.get(occurrence.module)! } : {}),
          line: occurrence.line,
          column: occurrence.column,
          offset: occurrence.offset,
          reason,
          ...(status ? { status } : {}),
          guarded,
        });
    }
  }
  for (const access of inventory.dynamicAccesses) {
    gaps.push({
      kind: "bun-api",
      name: access.basePath ? `${access.basePath}.*` : "Bun.*",
      module: access.module,
      ...(moduleKeys.has(access.module) ? { key: moduleKeys.get(access.module)! } : {}),
      line: access.line,
      column: access.column,
      offset: access.offset,
      reason: "dynamic-access",
      guarded: false,
    });
  }
  return gaps.sort(
    (a, b) => compare(a.module, b.module) || a.offset - b.offset || compare(a.name, b.name),
  );
}

export function findBuiltinGaps(
  bunApis: BunApiInventory,
  builtins: ReadonlyArray<BuiltinUse>,
  capabilities: BuiltinCapabilityManifest,
  moduleKeys: ReadonlyMap<string, string> = new Map(),
  guardedLocations: ReadonlySet<string> = new Set(),
): ReadonlyArray<ReleaseBuiltinGap> {
  return [
    ...findBunCapabilityGaps(bunApis, capabilities, moduleKeys, guardedLocations),
    ...findNodeBuiltinGaps(builtins, capabilities),
  ].sort(
    (a, b) =>
      compare(a.module, b.module) ||
      a.offset - b.offset ||
      compare(a.name, b.name) ||
      compare(a.kind, b.kind),
  );
}

/** The candidate fails when it introduces any newly unsupported leaf/member. */
export function diffNewBuiltinGaps(
  baseline: ReadonlyArray<ReleaseBuiltinGap>,
  candidate: ReadonlyArray<ReleaseBuiltinGap>,
): ReadonlyArray<ReleaseBuiltinGap> {
  const key = (item: ReleaseBuiltinGap) =>
    `${item.kind}\0${item.name}\0${"specifier" in item ? item.canonicalBuiltin : ""}\0${item.reason}`;
  const guardSuppresses = (item: ReleaseBuiltinGap) =>
    item.guarded &&
    ((item.kind === "bun-api" && item.reason === "unguarded-unsupported-use") ||
      (item.kind === "node-builtin" &&
        ["missing-named-export", "missing-commonjs-member"].includes(item.reason)));
  const dynamicSite = (item: ReleaseBuiltinGap) =>
    (item.kind === "bun-api" && item.reason === "dynamic-access") ||
    (item.kind === "node-builtin" && item.reason === "dynamic-member");
  const existing = new Set(
    baseline.filter((item) => !guardSuppresses(item) && !dynamicSite(item)).map(key),
  );
  const remainingDynamicSites = new Map<string, number>();
  for (const item of baseline)
    if (!guardSuppresses(item) && dynamicSite(item))
      remainingDynamicSites.set(key(item), (remainingDynamicSites.get(key(item)) ?? 0) + 1);
  const added: ReleaseBuiltinGap[] = [];
  for (const item of candidate) {
    if (guardSuppresses(item)) continue;
    if (dynamicSite(item)) {
      const remaining = remainingDynamicSites.get(key(item)) ?? 0;
      if (remaining > 0) remainingDynamicSites.set(key(item), remaining - 1);
      else added.push(item);
    } else if (!existing.has(key(item))) added.push(item);
  }
  return added.sort(
    (a, b) => compare(a.module, b.module) || a.offset - b.offset || compare(a.name, b.name),
  );
}

export function formatBuiltinGapFailures(gaps: ReadonlyArray<ReleaseBuiltinGap>): string {
  return gaps
    .map((item) => `${item.module}:${item.line}:${item.column}: ${item.name} (${item.reason})`)
    .join("\n");
}
