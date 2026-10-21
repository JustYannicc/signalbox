/**
 * V8 stores a string one byte per character only when every character fits in Latin-1. One wider
 * character makes the whole module two bytes per character in every isolate that loads it, so a
 * single legal notice once doubled the release's 50 MB source. esbuild escapes code, but leaves
 * legal comments, tagged templates and regex literals as written.
 */
const LEGAL_SUFFIX = ".LEGAL.txt";

/**
 * Moves esbuild's external legal notices back into their module as ASCII line comments, and fails
 * the build if any module would still load as a two-byte string.
 */
export function oneByteReleaseModules(
  files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
) {
  const notices = new Map(
    files
      .filter((file) => file.path.endsWith(LEGAL_SUFFIX))
      .map((file) => [file.path.slice(0, -LEGAL_SUFFIX.length), file.contents]),
  );
  return files
    .filter((file) => !file.path.endsWith(LEGAL_SUFFIX))
    .map((file) => {
      const notice = notices.get(file.path);
      const contents = notice === undefined ? file.contents : appendNotice(file.contents, notice);
      assertOneByte(file.path, contents);
      return { path: file.path, contents };
    });
}

function appendNotice(source: Uint8Array, notice: Uint8Array): Uint8Array {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(notice)
    .trimEnd()
    .split("\n")
    .map((line) => `// ${escapeNonAscii(line)}`);
  const suffix = new TextEncoder().encode(`\n${lines.join("\n")}\n`);
  const joined = new Uint8Array(source.length + suffix.length);
  joined.set(source);
  joined.set(suffix, source.length);
  return joined;
}

function escapeNonAscii(text: string): string {
  return text.replace(
    /[^\0-\x7f]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

function assertOneByte(path: string, contents: Uint8Array) {
  if (!path.endsWith(".js")) return;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  const index = text.search(/[^\0-\xff]/);
  if (index >= 0) {
    const excerpt = JSON.stringify(text.slice(Math.max(0, index - 40), index + 40));
    throw new Error(`BUNDLE_WIDE_SOURCE: ${path} at ${index}: ${excerpt}`);
  }
}
