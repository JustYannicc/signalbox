import { createContext, type ReactNode } from "react";

/**
 * Lets a surface render some `@handle` mentions itself instead of the file
 * chip, e.g. people and agents. Return `null` to keep the file chip. The
 * default (no provider) leaves the composer's `@` behavior untouched.
 */
export const ComposerMentionRendererContext = createContext<
  ((handle: string) => ReactNode | null) | null
>(null);

/** `@Flynn`, or `@"Northwind agent"` when the handle has spaces (the tokenizer's quoted form). */
export function formatComposerMention(handle: string): string {
  return /[\s"\\]/.test(handle) ? `@"${handle.replace(/(["\\])/g, "\\$1")}"` : `@${handle}`;
}
