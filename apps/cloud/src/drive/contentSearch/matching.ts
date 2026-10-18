import type { ProjectContentMatch, ProjectSearchContentsInput } from "@t3tools/contracts";
import { RE2JS } from "re2js";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
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

function replaceNewlineEscapes(text: string) {
  let result = "";
  let backslashes = 0;
  for (const character of text) {
    if (character === "n" && backslashes % 2 === 1) {
      result = `${result.slice(0, -1)}\n`;
    } else {
      result += character;
    }
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  return result;
}

interface FilePosition {
  readonly byteOffset: number;
  readonly lineNumber: number;
  readonly searchOffset: number;
}

export function makeContentMatcher(input: Omit<ProjectSearchContentsInput, "cwd">) {
  let regexFallbackError: string | undefined;
  let pattern: RE2JS;
  const flags = RE2JS.MULTILINE | (input.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  const literal = replaceNewlineEscapes(input.query);
  try {
    pattern = RE2JS.compile(input.useRegex ? input.query : RE2JS.quote(literal), flags);
  } catch (error) {
    regexFallbackError = error instanceof Error ? error.message : "Invalid regular expression.";
    pattern = RE2JS.compile(RE2JS.quote(literal), flags);
  }
  return {
    regexFallbackError,
    *lines(bytes: Uint8Array, position: FilePosition) {
      const text = decoder.decode(bytes);
      const matcher = pattern.matcher(text);
      let byteStart = position.byteOffset;
      let textStart = decoder.decode(bytes.subarray(0, byteStart)).length;
      let lineNumber = position.lineNumber;
      let from = position.searchOffset;
      const regex = input.useRegex && regexFallbackError === undefined;
      while (from <= text.length && matcher.find(from)) {
        const first = matcher.start();
        let newline = text.indexOf("\n", textStart);
        while (newline !== -1 && first > newline) {
          textStart = newline + 1;
          byteStart = bytes.indexOf(10, byteStart) + 1;
          lineNumber++;
          newline = text.indexOf("\n", textStart);
        }
        const byteNewline = bytes.indexOf(10, byteStart);
        let byteEnd = byteNewline === -1 ? bytes.length : byteNewline;
        while (byteEnd > byteStart && bytes[byteEnd - 1] === 13) byteEnd--;
        const lineContent = contentSnippet(bytes.subarray(byteStart, byteEnd));
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(textStart, lineEnd).replace(/\r+$/u, "");
        const ranges: ProjectContentMatch["matchRanges"][number][] = [];
        do {
          const start = matcher.start();
          const end = matcher.end();
          const relativeStart = start - textStart;
          const relativeEnd = Math.min(end - textStart, line.length);
          if (
            relativeStart < lineContent.length &&
            relativeEnd > relativeStart &&
            (!input.wholeWord || wholeWord(line, relativeStart, relativeEnd))
          ) {
            ranges.push({ start: relativeStart, end: Math.min(relativeEnd, lineContent.length) });
          }
          from = regex && end > start ? end : start + 1;
          if (from >= lineEnd || start - textStart >= lineContent.length) break;
        } while (matcher.find(from) && matcher.start() < lineEnd);
        yield {
          lineNumber,
          lineContent,
          matchRanges: ranges,
          byteOffset: byteNewline === -1 ? bytes.length : byteNewline + 1,
          searchOffset: Math.max(from, lineEnd + (newline === -1 ? 0 : 1)),
        };
        if (newline === -1) break;
        textStart = newline + 1;
        byteStart = byteNewline + 1;
        lineNumber++;
        from = Math.max(from, textStart);
      }
    },
  };
}

export function contentSnippet(bytes: Uint8Array) {
  let end = Math.min(bytes.length, SNIPPET_BYTES);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}
