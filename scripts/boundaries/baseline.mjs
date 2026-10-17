// Cycle membership is part of the identity, so extending a known cycle isn't grandfathered.
export function violationKey(violation) {
  return [
    violation.rule.name,
    violation.from,
    violation.to,
    ...(violation.cycle ?? []).map((item) => item.name).sort(),
  ].join(" | ");
}

export function checkBaseline(entries, previous) {
  const errors = [];
  if (new Set(entries).size !== entries.length) errors.push("Baseline contains duplicate entries.");
  if (previous) {
    const allowed = new Set(previous);
    for (const entry of entries) {
      if (!allowed.has(entry)) errors.push(`Baseline can only shrink; added: ${entry}`);
    }
  }
  return errors;
}
