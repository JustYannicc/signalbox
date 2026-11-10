/** Keeps saved-name winner selection identical for `w.start` and the library. */
export const preferSavedBlock = <A extends { readonly builtin_slug?: string | null }>(
  current: A | undefined,
  candidate: A | undefined,
): A | undefined => {
  if (current !== undefined) return current;
  return candidate && !candidate.builtin_slug ? candidate : undefined;
};
