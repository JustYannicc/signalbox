// @effect-diagnostics globalDate:off - this code runs inside the QuickJS sandbox, not under Effect.
/**
 * Plain-JS stand-ins for the web globals QuickJS lacks: structuredClone,
 * TextEncoder/TextDecoder (UTF-8 only), atob/btoa, URLSearchParams and
 * queueMicrotask. Installed before the compiled module so top-level code can
 * use them. Like the guest runtime, it's serialized with `Function#toString`
 * and must not reference anything outside its own body. Globals that can't be
 * shimmed honestly (Intl, URL, Buffer, …) are compile errors instead; see
 * `UNAVAILABLE_GLOBALS` in the compiler.
 */
export function installGuestGlobals() {
  type Bytes = ArrayLike<number>;
  const scope = globalThis as unknown as Record<string, unknown>;
  const named = (error: Error, name: string) => Object.assign(error, { name });

  const fromCodePoints = (points: number[]) => {
    let out = "";
    for (let index = 0; index < points.length; index += 4096) {
      out += String.fromCodePoint(...points.slice(index, index + 4096));
    }
    return out;
  };

  /** UTF-8 bytes of `text`; lone surrogates become U+FFFD like the real encoder. */
  const utf8Encode = (text: string) => {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index++) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdfff) {
        const low = text.charCodeAt(index + 1);
        if (code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index++;
        } else code = 0xfffd;
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000)
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63),
        );
    }
    return bytes;
  };

  /** Decodes UTF-8, replacing each invalid sequence with U+FFFD (or throwing when `fatal`). */
  const utf8Decode = (bytes: Bytes, fatal: boolean) => {
    const points: number[] = [];
    const invalid = () => {
      if (fatal) throw new TypeError("The encoded data isn't valid UTF-8.");
      points.push(0xfffd);
    };
    let index = 0;
    while (index < bytes.length) {
      const first = bytes[index]!;
      if (first < 0x80) {
        points.push(first);
        index++;
        continue;
      }
      let need = 0;
      let code = 0;
      let lower = 0x80;
      let upper = 0xbf;
      if (first >= 0xc2 && first <= 0xdf) [need, code] = [1, first & 0x1f];
      else if (first >= 0xe0 && first <= 0xef) {
        [need, code] = [2, first & 0x0f];
        if (first === 0xe0) lower = 0xa0;
        if (first === 0xed) upper = 0x9f;
      } else if (first >= 0xf0 && first <= 0xf4) {
        [need, code] = [3, first & 0x07];
        if (first === 0xf0) lower = 0x90;
        if (first === 0xf4) upper = 0x8f;
      } else {
        invalid();
        index++;
        continue;
      }
      let seen = 1;
      for (; seen <= need; seen++) {
        const next = bytes[index + seen];
        if (next === undefined || next < lower || next > upper) break;
        code = (code << 6) | (next & 0x3f);
        [lower, upper] = [0x80, 0xbf];
      }
      if (seen <= need) {
        invalid();
        index += seen;
        continue;
      }
      points.push(code);
      index += need + 1;
    }
    return fromCodePoints(points);
  };

  const viewBytes = (input: unknown) => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("Expected an ArrayBuffer, a typed array or a DataView.");
  };

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input: unknown = "") {
      return new Uint8Array(utf8Encode(String(input)));
    }
  }

  const FATAL = Symbol("fatal");
  const IGNORE_BOM = Symbol("ignoreBOM");
  class TextDecoder {
    [FATAL]: boolean;
    [IGNORE_BOM]: boolean;
    constructor(label: unknown = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
      const name = String(label).trim().toLowerCase();
      if (name !== "utf-8" && name !== "utf8" && name !== "unicode-1-1-utf-8") {
        throw new RangeError(`The "${String(label)}" encoding isn't supported here; use utf-8.`);
      }
      this[FATAL] = Boolean(options.fatal);
      this[IGNORE_BOM] = Boolean(options.ignoreBOM);
    }
    get encoding() {
      return "utf-8";
    }
    get fatal() {
      return this[FATAL];
    }
    get ignoreBOM() {
      return this[IGNORE_BOM];
    }
    decode(input?: unknown) {
      if (input === undefined) return "";
      const bytes = viewBytes(input);
      const bom = !this[IGNORE_BOM] && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      return utf8Decode(bom ? bytes.subarray(3) : bytes, this[FATAL]);
    }
  }

  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const btoa = (data: unknown) => {
    const text = String(data);
    const codes: number[] = [];
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code > 0xff) {
        throw named(
          new Error("btoa only takes characters up to U+00FF; encode text with TextEncoder first."),
          "InvalidCharacterError",
        );
      }
      codes.push(code);
    }
    let out = "";
    for (let index = 0; index < codes.length; index += 3) {
      const [a, b, c] = [codes[index]!, codes[index + 1], codes[index + 2]];
      const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
      out += BASE64[triple >> 18]! + BASE64[(triple >> 12) & 63]!;
      out += b === undefined ? "=" : BASE64[(triple >> 6) & 63]!;
      out += c === undefined ? "=" : BASE64[triple & 63]!;
    }
    return out;
  };
  const atob = (data: unknown) => {
    let text = String(data).replace(/[\t\n\f\r ]/g, "");
    if (text.length % 4 === 0) text = text.replace(/==?$/, "");
    if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) {
      throw named(new Error("The string isn't valid base64."), "InvalidCharacterError");
    }
    const codes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of text) {
      buffer = ((buffer << 6) | BASE64.indexOf(char)) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        codes.push((buffer >> bits) & 0xff);
      }
    }
    return fromCodePoints(codes);
  };

  const isFormSafe = (byte: number) =>
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2a ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f;
  /** application/x-www-form-urlencoded, as URLSearchParams#toString writes it. */
  const formEncode = (text: string) =>
    utf8Encode(text)
      .map((byte) =>
        isFormSafe(byte)
          ? String.fromCharCode(byte)
          : byte === 0x20
            ? "+"
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
  const formDecode = (text: string) => {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      const hex = text.slice(index + 1, index + 3);
      if (char === "+") bytes.push(0x20);
      else if (char === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        index += 2;
      } else {
        const point = String.fromCodePoint(text.codePointAt(index)!);
        bytes.push(...utf8Encode(point));
        index += point.length - 1;
      }
    }
    return utf8Decode(bytes, false);
  };

  const LIST = Symbol("list");
  class URLSearchParams {
    [LIST]: [string, string][];
    constructor(init?: unknown) {
      const list: [string, string][] = (this[LIST] = []);
      if (init === undefined || init === null) return;
      if (typeof init === "object" && Symbol.iterator in init) {
        for (const pair of init as Iterable<Iterable<unknown>>) {
          const entry = Array.from(pair);
          if (entry.length !== 2)
            throw new TypeError("Each pair needs exactly a name and a value.");
          list.push([String(entry[0]), String(entry[1])]);
        }
      } else if (typeof init === "object") {
        const record = init as Record<string, unknown>;
        for (const name of Object.keys(record)) list.push([name, String(record[name])]);
      } else {
        const text = String(init);
        for (const part of (text.startsWith("?") ? text.slice(1) : text).split("&")) {
          if (!part) continue;
          const split = part.indexOf("=");
          const [name, value] =
            split < 0 ? [part, ""] : [part.slice(0, split), part.slice(split + 1)];
          list.push([formDecode(name), formDecode(value)]);
        }
      }
    }
    get size() {
      return this[LIST].length;
    }
    append(name: unknown, value: unknown) {
      this[LIST].push([String(name), String(value)]);
    }
    delete(name: unknown, value?: unknown) {
      const [key, match] = [String(name), value === undefined ? undefined : String(value)];
      this[LIST] = this[LIST].filter(([n, v]) => n !== key || (match !== undefined && v !== match));
    }
    get(name: unknown) {
      const key = String(name);
      return this[LIST].find(([n]) => n === key)?.[1] ?? null;
    }
    getAll(name: unknown) {
      const key = String(name);
      return this[LIST].filter(([n]) => n === key).map(([, v]) => v);
    }
    has(name: unknown, value?: unknown) {
      const [key, match] = [String(name), value === undefined ? undefined : String(value)];
      return this[LIST].some(([n, v]) => n === key && (match === undefined || v === match));
    }
    set(name: unknown, value: unknown) {
      const [key, text] = [String(name), String(value)];
      const index = this[LIST].findIndex(([n]) => n === key);
      if (index < 0) return void this[LIST].push([key, text]);
      this[LIST][index] = [key, text];
      this[LIST] = this[LIST].filter(([n], at) => at <= index || n !== key);
    }
    sort() {
      this[LIST].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
    forEach(
      callback: (value: string, name: string, params: URLSearchParams) => void,
      self?: unknown,
    ) {
      for (const [name, value] of this[LIST]) callback.call(self, value, name, this);
    }
    *entries(): IterableIterator<[string, string]> {
      for (const [name, value] of this[LIST]) yield [name, value];
    }
    *keys() {
      for (const [name] of this[LIST]) yield name;
    }
    *values() {
      for (const [, value] of this[LIST]) yield value;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this[LIST]
        .map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`)
        .join("&");
    }
  }

  const uncloneable = (what: string) =>
    named(new Error(`${what} can't be cloned.`), "DataCloneError");
  const clone = (value: unknown, seen: Map<object, unknown>): unknown => {
    if (typeof value === "function") throw uncloneable("A function");
    if (typeof value === "symbol") throw uncloneable("A symbol");
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const keep = <T>(copy: T) => {
      seen.set(value, copy);
      return copy;
    };
    if (value instanceof Date) return keep(new Date(value.getTime()));
    if (value instanceof RegExp) return keep(new RegExp(value.source, value.flags));
    if (value instanceof ArrayBuffer) return keep(value.slice(0));
    if (value instanceof DataView) {
      const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return keep(new DataView(buffer));
    }
    if (ArrayBuffer.isView(value)) return keep((value as unknown as Uint8Array).slice());
    if (value instanceof Error) {
      const copy = keep(new Error(value.message));
      copy.name = value.name;
      return copy;
    }
    if (value instanceof Map) {
      const copy = keep(new Map());
      for (const [key, item] of value) copy.set(clone(key, seen), clone(item, seen));
      return copy;
    }
    if (value instanceof Set) {
      const copy = keep(new Set());
      for (const item of value) copy.add(clone(item, seen));
      return copy;
    }
    const record = value as Record<string, unknown>;
    const copy = keep((Array.isArray(value) ? [] : {}) as Record<string, unknown>);
    for (const key of Object.keys(record)) copy[key] = clone(record[key], seen);
    if (Array.isArray(value)) (copy as unknown as unknown[]).length = value.length;
    return copy;
  };

  scope.structuredClone = (value: unknown) => clone(value, new Map());
  scope.TextEncoder = TextEncoder;
  scope.TextDecoder = TextDecoder;
  scope.btoa = btoa;
  scope.atob = atob;
  scope.URLSearchParams = URLSearchParams;
  scope.queueMicrotask = (callback: unknown) => {
    if (typeof callback !== "function") throw new TypeError("queueMicrotask needs a function.");
    void Promise.resolve().then(() => callback());
  };
}
