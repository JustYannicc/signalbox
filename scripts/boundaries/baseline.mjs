// A reported cycle path can change when another edge is removed. Track cyclic edges instead.
export function violationKey(violation) {
  return [violation.rule.name, violation.from, violation.to].join(" | ");
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
