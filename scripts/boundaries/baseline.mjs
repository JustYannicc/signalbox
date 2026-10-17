// A reported cycle path can change when another edge is removed. Track cyclic edges instead.
export function violationKey(violation) {
  return [violation.rule.name, violation.from, violation.to].join(" | ");
}

// Older scans omitted cyclic edges. Recognize that existing debt without growing the file.
export function unrecordedBaseCycles(violations, previous, legacyViolations, legacyBaseline) {
  if (!previous) return new Set();
  const recorded = new Set(previous);
  const legacyRecorded = new Set(legacyBaseline);
  const legacy = new Set(
    legacyViolations
      .filter((violation) => violation.rule.name === "no-circular")
      .map(violationKey)
      .filter((key) => !legacyRecorded.has(key)),
  );
  return new Set(
    violations
      .filter((violation) => violation.rule.name === "no-circular")
      .map(violationKey)
      .filter((key) => !recorded.has(key) && legacy.has(key)),
  );
}

export function checkBaseline(entries, previous, current) {
  const errors = [];
  if (new Set(entries).size !== entries.length) errors.push("Baseline contains duplicate entries.");
  if (previous) {
    const allowed = new Set(previous);
    for (const entry of entries) {
      if (!allowed.has(entry)) errors.push(`Baseline can only shrink; added: ${entry}`);
    }
  }
  if (current) {
    const active = new Set(current);
    for (const entry of entries) {
      if (!active.has(entry)) errors.push(`Remove stale baseline entry: ${entry}`);
    }
  }
  return errors;
}
