import { findBunApiUses, type BunApiAccess } from "./bun-api-bindings.ts";

export type { BunApiAccess } from "./bun-api-bindings.ts";

export interface BunApiOccurrence {
  readonly module: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly access: BunApiAccess;
}

export interface BunApiMember {
  readonly path: string;
  readonly occurrences: ReadonlyArray<BunApiOccurrence>;
}

/**
 * An access not attributable to an exact API path, such as computed access,
 * destructuring rest/spread, or an alias that may refer to Bun. `basePath` is
 * the known Bun member prefix; empty means Bun itself or an uncertain alias.
 */
export interface BunApiDynamicAccess extends BunApiOccurrence {
  /** Known Bun member prefix before the unresolved access; empty for Bun or an uncertain alias. */
  readonly basePath: string;
}

export interface BunApiInventory {
  readonly members: ReadonlyArray<BunApiMember>;
  readonly dynamicAccesses: ReadonlyArray<BunApiDynamicAccess>;
}

/** Inventory Bun API access in already-decoded source modules without executing source. */
export function inventoryBunApis(
  modules: ReadonlyArray<{ readonly name: string; readonly source: string }>,
): BunApiInventory {
  const members = new Map<string, BunApiOccurrence[]>();
  const dynamicAccesses: BunApiDynamicAccess[] = [];

  for (const module of modules) {
    for (const use of findBunApiUses(module.name, module.source)) {
      if (use.path !== undefined) {
        const occurrence: BunApiOccurrence = {
          module: use.module,
          offset: use.offset,
          line: use.line,
          column: use.column,
          access: use.access,
        };
        const found = members.get(use.path);
        if (found) found.push(occurrence);
        else members.set(use.path, [occurrence]);
      } else {
        dynamicAccesses.push({
          module: use.module,
          offset: use.offset,
          line: use.line,
          column: use.column,
          access: use.access,
          basePath: use.basePath,
        });
      }
    }
  }

  return {
    members: [...members]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, occurrences]) => ({
        path,
        occurrences: occurrences.sort(compareOccurrence),
      })),
    dynamicAccesses: dynamicAccesses.sort(
      (left, right) =>
        left.module.localeCompare(right.module) ||
        left.offset - right.offset ||
        left.basePath.localeCompare(right.basePath) ||
        left.access.localeCompare(right.access),
    ),
  };
}

function compareOccurrence(left: BunApiOccurrence, right: BunApiOccurrence): number {
  return (
    left.module.localeCompare(right.module) ||
    left.offset - right.offset ||
    left.access.localeCompare(right.access)
  );
}
