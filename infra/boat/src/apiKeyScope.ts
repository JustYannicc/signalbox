import type { ApiKeyAttributes, ApiKeyProps } from "./ApiKey.ts";

export const scopeList = (value: unknown): string[] | "*" | undefined =>
  value === "*"
    ? "*"
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").sort()
      : undefined;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Why a declared restriction can't be met by the observed key, if it can't.
 * Only what Boat reports is compared: a preset or TTL can't be checked on a
 * key Alchemy didn't create.
 */
export const scopeMismatch = (
  news: Pick<ApiKeyProps, "actions" | "sandboxIds" | "environmentIds">,
  output: Pick<ApiKeyAttributes, "actions" | "sandboxIds" | "environmentIds">,
) => {
  if (news.actions !== undefined && output.actions.length > 0) {
    if (!sameSet(news.actions, output.actions)) return "actions";
  }
  for (const field of ["sandboxIds", "environmentIds"] as const) {
    const want = news[field];
    const have = output[field];
    if (want === undefined || have === undefined) continue;
    if (have === "*" || !sameSet(want, have)) return field;
  }
  return undefined;
};
