function sameValue(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => sameValue(actual[index], value))
    );
  if (
    expected === null ||
    typeof expected !== "object" ||
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  )
    return false;
  const keys = Object.keys(expected);
  return (
    Object.keys(actual).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(actual, key) &&
        sameValue(Reflect.get(actual, key), Reflect.get(expected, key)),
    )
  );
}

/** The SDK inserts this documented default when replaying a single Edit. */
export function matchesClaudeActionInput(
  name: string,
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (
    name === "Edit" &&
    !Object.hasOwn(expected, "replace_all") &&
    Object.hasOwn(actual, "replace_all")
  ) {
    if (actual.replace_all !== false) return false;
    const { replace_all: _default, ...rest } = actual;
    return sameValue(rest, expected);
  }
  return sameValue(actual, expected);
}
