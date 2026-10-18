import type { ProjectContentMatch, ProjectSearchContentsInput } from "@t3tools/contracts";
import { RE2JS } from "re2js";

const decoder = new TextDecoder();
const wordCharacter = /[\p{Letter}\p{Mark}\p{Number}_]/u;
const SNIPPET_BYTES = 512;

// Keep the corpus aligned with fff-node 0.11.0's binary-extension classification.
const binaryExtensions = new Set(
  `
png jpg jpeg gif bmp ico webp tiff tif avif heic heif jxl jp2 j2k psd icns cur cr2 nef dng tga
rgbe hdr exr dds ktx ktx2 pvr astc ai webarchive mhtml
mp4 avi mov wmv mkv mp3 wav flac ogg m4a aac webm flv mpg mpeg wma opus pcm reapeaks
zip tar gz bz2 xz 7z rar zst lz4 lzma cab cpio jsonlz4
deb rpm apk dmg msi iso nupkg whl egg appimage flatpak crx pak
exe dll so dylib o a lib bin elf pdf doc docx xls xlsx ppt pptx db sqlite sqlite3 mdb
sqlite-wal sqlite-shm sqlite3-wal sqlite3-shm db-wal db-shm ldb ttf otf woff woff2 eot
class pyc pyo wasm dex jar war cmi cmt cmti cmx nib swiftdeps swiftdeps~ swiftdoc swiftmodule swiftsourceinfo
npy npz h5 hdf5 pt onnx safetensors tfrecord tflite gguf ggml joblib glb blend blp dia bcmap pb parquet arrow suo
`
    .trim()
    .split(/\s+/u),
);

export const isKnownBinaryPath = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && binaryExtensions.has(name.slice(dot + 1));
};

const codePointAt = (text: string, index: number) => {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
};
const codePointBefore = (text: string, index: number) => {
  const unit = text.charCodeAt(index - 1);
  return codePointAt(text, unit >= 0xdc00 && unit <= 0xdfff ? index - 2 : index - 1);
};
const wholeWord = (line: string, start: number, end: number) =>
  end > start &&
  (start === 0 ||
    !wordCharacter.test(codePointBefore(line, start)) ||
    !wordCharacter.test(codePointAt(line, start))) &&
  (end === line.length ||
    !wordCharacter.test(codePointAt(line, end)) ||
    !wordCharacter.test(codePointBefore(line, end)));

export function makeContentMatcher(input: Omit<ProjectSearchContentsInput, "cwd">) {
  let regexFallbackError: string | undefined;
  let pattern: RE2JS;
  const flags = input.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE;
  try {
    pattern = RE2JS.compile(input.useRegex ? input.query : RE2JS.quote(input.query), flags);
  } catch (error) {
    regexFallbackError = error instanceof Error ? error.message : "Invalid regular expression.";
    pattern = RE2JS.compile(RE2JS.quote(input.query), flags);
  }
  return {
    regexFallbackError,
    test: (line: string) => pattern.test(line),
    ranges: (line: string, snippet: string) => {
      const matcher = pattern.matcher(line);
      const ranges: ProjectContentMatch["matchRanges"][number][] = [];
      let from = 0;
      while (from <= snippet.length && matcher.find(from)) {
        const start = matcher.start();
        const end = matcher.end();
        if (start >= snippet.length) break;
        if (end > start && (!input.wholeWord || wholeWord(line, start, end))) {
          ranges.push({ start, end: Math.min(end, snippet.length) });
        }
        // Literal highlighting includes overlapping occurrences. Regex follows RE2's
        // non-overlapping matches; either mode must advance past empty matches.
        from = input.useRegex && regexFallbackError === undefined && end > start ? end : start + 1;
      }
      return ranges;
    },
  };
}

export function contentSnippet(bytes: Uint8Array) {
  let end = Math.min(bytes.length, SNIPPET_BYTES);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}
