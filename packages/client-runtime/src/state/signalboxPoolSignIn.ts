// signalbox: what web and mobile share when an account signs into a pool (#205).

/**
 * True for a whole hand-back from a provider's sign-in: the `code#state`
 * Anthropic's code page shows, or the address the sign-in ends on. Pasting
 * one finishes the sign-in without a button press.
 */
export function isSignInHandBack(text: string): boolean {
  if (/^[\w.~-]+#[\w.~-]+$/.test(text)) return true;
  try {
    return new URL(text).searchParams.has("code");
  } catch {
    return false;
  }
}
