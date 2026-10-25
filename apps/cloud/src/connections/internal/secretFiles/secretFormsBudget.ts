interface TextMetrics {
  length: number;
  quotes: number;
  backslashes: number;
  shortControls: number;
  otherControls: number;
  nonPrintable: number;
}

export interface SecretFormsScratchEstimate {
  /** Upper bound for strings, typed buffers, collection rows, and JSON temporaries. */
  readonly peakBytes: number;
}

const BASE_COUNT = 15;
const FORMS_PER_BASE = 5;
const CANDIDATE_COUNT = BASE_COUNT * FORMS_PER_BASE;

/**
 * Preflights the eager shared scrubber before it builds up to 15 bases and five
 * JSON/ASCII forms for each. The formulas follow SecretScrubber.secretForms;
 * actual form selection and matching still come from that shared scrubber.
 */
export function estimateSecretFormsScratch(
  value: string,
  utf8Bytes: number,
): SecretFormsScratchEstimate {
  const valueMetrics = newMetrics();
  const singleQuoted = newMetrics();
  const doubleEscaped = newMetrics();
  const shellEscaped = newMetrics();
  let urlLength = 0;
  let urlPlusLength = 0;

  for (let at = 0; at < value.length;) {
    const codePoint = value.codePointAt(at)!;
    const width = codePoint > 0xffff ? 2 : 1;
    for (let index = 0; index < width; index += 1) {
      const codeUnit = value.charCodeAt(at + index);
      addCodeUnit(valueMetrics, codeUnit);

      if (codeUnit === 0x27) {
        addCodeUnit(singleQuoted, 0x27);
        addCodeUnit(singleQuoted, 0x5c);
        addCodeUnit(singleQuoted, 0x27);
        addCodeUnit(singleQuoted, 0x27);
      } else {
        addCodeUnit(singleQuoted, codeUnit);
      }

      if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x24 || codeUnit === 0x60) {
        addCodeUnit(doubleEscaped, 0x5c);
      }
      addCodeUnit(doubleEscaped, codeUnit);

      if (!isShellSafe(codeUnit)) addCodeUnit(shellEscaped, 0x5c);
      addCodeUnit(shellEscaped, codeUnit);
    }

    const byteWidth = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (isUriUnescaped(codePoint)) {
      urlLength += 1;
      urlPlusLength += 1;
    } else {
      urlLength += byteWidth * 3;
      urlPlusLength += byteWidth * 3;
    }
    if (codePoint === 0x20) {
      urlPlusLength -= 2;
    }
    at += width;
  }

  const bases: Array<TextMetrics> = [
    valueMetrics,
    singleQuoted,
    doubleEscaped,
    shellEscaped,
    plainAscii(urlLength),
    plainAscii(urlPlusLength),
    plainAscii(urlLength),
    plainAscii(utf8Bytes * 2),
    plainAscii(utf8Bytes * 2),
  ];
  let encodedTemporaryCharacters = 0;
  for (let offset = 0; offset < 3; offset += 1) {
    const paddedLength = utf8Bytes + offset;
    const encodedLength = Math.ceil(paddedLength / 3) * 4;
    const first = Math.ceil((offset * 4) / 3);
    const end = Math.floor(((offset + utf8Bytes) * 4) / 3);
    // `secretForms` slices the complete encodings; their output alphabet is JSON-safe ASCII.
    const slicedLength = Math.max(0, end - first);
    encodedTemporaryCharacters += encodedLength * 2;
    bases.push(plainAscii(slicedLength), plainAscii(slicedLength));
  }

  let baseCharacters = 0;
  let formCharacters = 0;
  let jsonTemporaryCharacters = 0;
  for (const base of bases) {
    baseCharacters += base.length;
    const once = jsonMetrics(base);
    const twice = jsonMetrics(once);
    const asciiOnce = asciiMetrics(once);
    const asciiTwice = asciiMetrics(twice);
    formCharacters +=
      base.length + once.length + twice.length + asciiOnce.length + asciiTwice.length;
    // JSON.stringify creates a quoted temporary before .slice removes the quotes.
    jsonTemporaryCharacters += once.length + twice.length + 4;
  }

  const typedBufferBytes = utf8Bytes + (utf8Bytes + 2);
  const collectionBytes = BASE_COUNT * 32 + CANDIDATE_COUNT * 96 + 1024;
  return {
    peakBytes:
      baseCharacters * 2 +
      formCharacters * 2 +
      jsonTemporaryCharacters * 2 +
      encodedTemporaryCharacters * 2 +
      typedBufferBytes +
      collectionBytes,
  };
}

function newMetrics(): TextMetrics {
  return {
    length: 0,
    quotes: 0,
    backslashes: 0,
    shortControls: 0,
    otherControls: 0,
    nonPrintable: 0,
  };
}

function plainAscii(length: number): TextMetrics {
  return { ...newMetrics(), length };
}

function addCodeUnit(metrics: TextMetrics, codeUnit: number): void {
  metrics.length += 1;
  if (codeUnit === 0x22) metrics.quotes += 1;
  if (codeUnit === 0x5c) metrics.backslashes += 1;
  if (
    codeUnit === 0x08 ||
    codeUnit === 0x09 ||
    codeUnit === 0x0a ||
    codeUnit === 0x0c ||
    codeUnit === 0x0d
  ) {
    metrics.shortControls += 1;
  } else if (codeUnit < 0x20) {
    metrics.otherControls += 1;
  }
  if (codeUnit < 0x20 || codeUnit > 0x7e) metrics.nonPrintable += 1;
}

function jsonMetrics(input: TextMetrics): TextMetrics {
  const controlCount = input.shortControls + input.otherControls;
  return {
    length:
      input.length +
      input.quotes +
      input.backslashes +
      input.shortControls +
      input.otherControls * 5,
    quotes: input.quotes,
    backslashes: input.backslashes * 2 + input.quotes + input.shortControls + input.otherControls,
    shortControls: 0,
    otherControls: 0,
    nonPrintable: input.nonPrintable - controlCount,
  };
}

function asciiMetrics(input: TextMetrics): TextMetrics {
  return {
    length: input.length + input.nonPrintable * 5,
    quotes: input.quotes,
    backslashes: input.backslashes + input.nonPrintable,
    shortControls: input.shortControls,
    otherControls: input.otherControls,
    nonPrintable: 0,
  };
}

function isShellSafe(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a) ||
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    codeUnit === 0x5f ||
    codeUnit === 0x2d ||
    codeUnit === 0x2e ||
    codeUnit === 0x2c ||
    codeUnit === 0x3a ||
    codeUnit === 0x2f ||
    codeUnit === 0x40 ||
    codeUnit === 0x25 ||
    codeUnit === 0x2b ||
    codeUnit === 0x3d
  );
}

function isUriUnescaped(codePoint: number): boolean {
  return (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0x2d ||
    codePoint === 0x5f ||
    codePoint === 0x2e ||
    codePoint === 0x21 ||
    codePoint === 0x7e ||
    codePoint === 0x2a ||
    codePoint === 0x27 ||
    codePoint === 0x28 ||
    codePoint === 0x29
  );
}
