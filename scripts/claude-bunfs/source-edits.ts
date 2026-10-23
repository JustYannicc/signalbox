/** Assemble replacements once so edits to a large release do not repeatedly copy its source. */
export function applySourceEdits(
  source: string,
  edits: readonly { readonly start: number; readonly end: number; readonly text: string }[],
) {
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length)
      throw new Error("SOURCE_EDITS_INVALID");
    chunks.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}
