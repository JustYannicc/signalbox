// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI script helpers, run by signalbox-ci.yml.
/**
 * Fork hook lines (`// signalbox: …` and its `#`, block and JSX forms) that an
 * upstream merge must keep. A hook may move when upstream refactors the code
 * around it, so it's matched by its text anywhere in the tree, not by file.
 */
import { git, isAncestor } from "./mergeTree.ts";

export interface Hook {
  readonly file: string;
  readonly text: string;
}

const HOOK = /(?:\/\/|#|\/\*|\{\/\*|<!--)\s*signalbox:\s*(.*?)\s*(?:\*\/\s*\}?|-->)?\s*$/;

/** The hook text on one line of source, if it has one. */
export function hookText(line: string): string | undefined {
  return HOOK.exec(line)?.[1] || undefined;
}

/**
 * Hook lines `head` removes and adds since it left `base` (`base...head`), so
 * commits `base` gained later don't count. Outside vendored references.
 */
export function hookChanges(
  cwd: string,
  refs: { readonly base: string; readonly head: string },
): { readonly removed: Hook[]; readonly added: Hook[] } {
  const diff = git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "-U0",
    `${refs.base}...${refs.head}`,
    "--",
    ".",
    ":!.repos",
  ]);
  const removed: Hook[] = [];
  const added: Hook[] = [];
  let before = "";
  let after = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) before = line.slice(line.startsWith("--- a/") ? 6 : 4);
    else if (line.startsWith("+++ ")) after = line.slice(line.startsWith("+++ b/") ? 6 : 4);
    else if (line.startsWith("-") || line.startsWith("+")) {
      const text = hookText(line.slice(1));
      if (text === undefined) continue;
      if (line.startsWith("-")) removed.push({ file: before, text });
      else added.push({ file: after, text });
    }
  }
  return { removed, added };
}

/** Removed hooks no added one replaces: one per missing copy of the same text. */
export function droppedHooks(removed: ReadonlyArray<Hook>, added: ReadonlyArray<Hook>): Hook[] {
  const kept = new Map<string, number>();
  for (const hook of added) kept.set(hook.text, (kept.get(hook.text) ?? 0) + 1);
  return removed.filter((hook) => {
    const left = kept.get(hook.text) ?? 0;
    if (left === 0) return true;
    kept.set(hook.text, left - 1);
    return false;
  });
}

/**
 * Files upstream deleted, not renamed, since `base` last merged it. A hook in
 * one goes with the code it hooked, so losing it isn't a dropped hook.
 */
export function deletedUpstream(
  cwd: string,
  refs: { readonly base: string; readonly upstream: string },
): Set<string> {
  const since = git(cwd, ["merge-base", refs.base, refs.upstream]);
  const changes = git(cwd, ["diff", "--name-status", "--find-renames", since, refs.upstream]);
  return new Set(
    changes.split("\n").flatMap((line) => {
      const [status, file] = line.split("\t");
      return status === "D" && file ? [file] : [];
    }),
  );
}

/** True when `head` brings in upstream commits that `base` doesn't have yet. */
export function mergesUpstream(
  cwd: string,
  refs: { readonly base: string; readonly head: string; readonly upstream: string },
): boolean {
  return !isAncestor(cwd, git(cwd, ["merge-base", refs.head, refs.upstream]), refs.base);
}
