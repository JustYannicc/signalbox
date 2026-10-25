export type FixtureInventoryEntry = {
  name: string;
  type: "js";
  bytes: number;
  sha256: string;
};

export type FixtureInventory = FixtureInventoryEntry[];

const EXPECTED_MODULES = [
  "main.js",
  "bun-container.js",
  "bun-graph.js",
  "range-reader.js",
] as const;

const EXPECTED_MODULE_SET = new Set<string>(EXPECTED_MODULES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateFixtureInventory(
  value: unknown,
  label: string,
): { inventory?: FixtureInventory; mismatches: string[] } {
  const mismatches: string[] = [];
  if (!Array.isArray(value)) {
    return { mismatches: [`${label}: measurement row has no inventory array.`] };
  }

  if (value.length !== EXPECTED_MODULES.length) {
    mismatches.push(
      `${label}: expected ${EXPECTED_MODULES.length} fixture inventory entries, found ${value.length}.`,
    );
  }

  const seen = new Set<string>();
  const entries = new Map<string, FixtureInventoryEntry>();
  for (const [index, valueEntry] of value.entries()) {
    if (!isRecord(valueEntry)) {
      mismatches.push(`${label}: inventory entry ${index} is not an object.`);
      continue;
    }

    const name = valueEntry.name;
    if (typeof name !== "string") {
      mismatches.push(`${label}: inventory entry ${index} has no module name.`);
      continue;
    }
    const moduleLabel = EXPECTED_MODULE_SET.has(name) ? name : `entry ${index}`;
    if (seen.has(name)) {
      mismatches.push(`${label}: inventory contains duplicate module ${moduleLabel}.`);
    }
    seen.add(name);
    if (!EXPECTED_MODULE_SET.has(name)) {
      mismatches.push(`${label}: inventory contains an unexpected module at entry ${index}.`);
    }

    const typeIsValid = valueEntry.type === "js";
    if (!typeIsValid) mismatches.push(`${label}: inventory ${moduleLabel} is not type js.`);

    const bytes = valueEntry.bytes;
    const bytesAreValid = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
    if (!bytesAreValid) {
      mismatches.push(`${label}: inventory ${moduleLabel} has an invalid byte length.`);
    }

    const sha256 = valueEntry.sha256;
    const hashIsValid = isHash(sha256);
    if (!hashIsValid) mismatches.push(`${label}: inventory ${moduleLabel} has an invalid SHA-256.`);

    if (
      EXPECTED_MODULE_SET.has(name) &&
      !entries.has(name) &&
      typeIsValid &&
      bytesAreValid &&
      hashIsValid
    ) {
      entries.set(name, { name, type: "js", bytes, sha256 });
    }
  }

  for (const name of EXPECTED_MODULES) {
    if (!seen.has(name)) mismatches.push(`${label}: inventory is missing module ${name}.`);
  }

  if (mismatches.length > 0) return { mismatches };
  return {
    inventory: EXPECTED_MODULES.map((name) => entries.get(name)!),
    mismatches,
  };
}

export function compareFixtureInventories(
  expected: FixtureInventory,
  actual: FixtureInventory,
  label: string,
  mismatches: string[],
) {
  for (let index = 0; index < EXPECTED_MODULES.length; index++) {
    const expectedEntry = expected[index]!;
    const actualEntry = actual[index]!;
    for (const field of ["name", "type", "bytes", "sha256"] as const) {
      if (actualEntry[field] !== expectedEntry[field]) {
        const fieldLabel = field === "sha256" ? "SHA-256" : field;
        mismatches.push(
          `${label}: inventory ${expectedEntry.name} ${fieldLabel} differs across proof rows.`,
        );
      }
    }
  }
}
