import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { structuredPatch } from "diff";
import type { Bytes } from "./git/gitObjects.ts";

/**
 * One changed file as `git diff --patch` prints it, with `a/` and `b/`
 * prefixes: what clients' diff views parse. Whole-file contents in, no git
 * needed.
 */

export interface FileSide {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  /** Null for a file too big to diff, which is never read. */
  readonly content: Bytes | null;
}

const ZERO_OID = "0000000";
const short = (oid: string) => oid.slice(0, 7);

/** git's own test: a NUL in the first 8000 bytes. */
export const isBinary = (bytes: Bytes) => bytes.subarray(0, 8000).includes(0);

const decoder = new TextDecoder();

/** Sides bigger than this, or changes needing more edits, are not diffed line by line. */
export const MAX_DIFF_BYTES = 512 * 1024;
const MAX_EDIT_LENGTH = 20_000;

/** A hunk side as git writes it: the count is left out when it is 1. */
const span = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

export function filePatch(
  before: FileSide | null,
  after: FileSide | null,
  options: { readonly ignoreWhitespace: boolean },
): string {
  const path = (after ?? before)!.path;
  const lines = [
    `diff --git ${quoteGitPatchPath(`a/${before?.path ?? path}`)} ${quoteGitPatchPath(`b/${after?.path ?? path}`)}`,
  ];
  if (before === null) lines.push(`new file mode ${after!.mode}`);
  else if (after === null) lines.push(`deleted file mode ${before.mode}`);
  else if (before.mode !== after.mode)
    lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`);
  const sameMode = before !== null && after !== null && before.mode === after.mode;
  lines.push(
    `index ${before === null ? ZERO_OID : short(before.oid)}..${after === null ? ZERO_OID : short(after.oid)}${sameMode ? ` ${after.mode}` : ""}`,
  );
  const oldName = before === null ? "/dev/null" : quoteGitPatchPath(`a/${before.path}`);
  const newName = after === null ? "/dev/null" : quoteGitPatchPath(`b/${after.path}`);
  if (
    (before?.content != null && isBinary(before.content)) ||
    (after?.content != null && isBinary(after.content))
  ) {
    lines.push(`Binary files ${oldName} and ${newName} differ`);
    return `${lines.join("\n")}\n`;
  }
  // Diffing is quadratic in the worst case; a huge rewrite shows as changed, without lines.
  const tooLarge = [before, after].some(
    (side) => side !== null && (side.content === null || side.content.length > MAX_DIFF_BYTES),
  );
  const patch = tooLarge
    ? undefined
    : structuredPatch(
        oldName,
        newName,
        before?.content == null ? "" : decoder.decode(before.content),
        after?.content == null ? "" : decoder.decode(after.content),
        undefined,
        undefined,
        { context: 3, ignoreWhitespace: options.ignoreWhitespace, maxEditLength: MAX_EDIT_LENGTH },
      );
  if (patch === undefined) return `${lines.join("\n")}\n`;
  if (patch.hunks.length === 0) {
    // Only the mode changed, or only whitespace when that is ignored.
    return before !== null && after !== null && !sameMode ? `${lines.join("\n")}\n` : "";
  }
  lines.push(`--- ${oldName}`, `+++ ${newName}`);
  for (const hunk of patch.hunks) {
    // git counts an empty side from 0.
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    lines.push(
      `@@ -${span(oldStart, hunk.oldLines)} +${span(newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    );
  }
  return `${lines.join("\n")}\n`;
}
