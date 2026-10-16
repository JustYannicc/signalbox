import { findOperation } from "@signalbox/api/catalog";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";

/**
 * The one step the CLI and `signalbox mcp` add to a call: operations whose
 * reach `compiles` (automation saves and checks) get their `source` compiled
 * here, because the cloud can't compile (#558). The cloud still checks what it
 * gets. A file that doesn't compile is answered here with what to fix, the
 * same `{ ok: false, diagnostics }` the operation would answer, and never sent.
 */
export type Prepared =
  | { readonly _tag: "send"; readonly input: unknown }
  | { readonly _tag: "answer"; readonly value: unknown };

export const prepareCall = (name: string, input: unknown): Prepared => {
  const source = (input as { readonly source?: unknown } | null)?.source;
  // Anything else goes as it is; the API says what's wrong with it.
  if (findOperation(name)?.compiles !== true || typeof source !== "string") {
    return { _tag: "send", input };
  }
  const result = compileForCloud(source);
  return result.ok
    ? { _tag: "send", input: { ...(input as object), compiled: result.compiled } }
    : { _tag: "answer", value: { ok: false, diagnostics: result.diagnostics } };
};
