import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

/**
 * The one scrubber for a thread's secrets (#591): every value resolved for it,
 * in every form a tool is likely to print it in, replaced by its placeholder
 * `{{secret:NAME}}`. It runs wherever text leaves the machine: the cloud's
 * side of the ModelGateway on every model request (`modelGrants.ts`), and the
 * Runner on its frames, session rows and logs (`secretMask.ts`). The
 * placeholder is what #592 later fills back in at the boundary.
 *
 * Deterministic: the same text and secrets always give the same output, and
 * text holding no secret comes back unchanged, so prompt caching holds.
 *
 * Overlapping matches are masked as one span, so no piece of either secret is
 * left between them. Text that arrives in pieces goes through `stream`, which
 * holds back the longest form minus one character so a value split across
 * chunks is still caught (OpenHands' `StreamOutputMask`).
 */

/** A secret to hide: its name, which its placeholder carries, and its value. */
export const SecretValue = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  value: Schema.String,
});
export type SecretValue = typeof SecretValue.Type;

/**
 * Shorter values are left alone: masking `1` or `true` would garble every
 * transcript and hides nothing.
 */
export const MIN_SCRUBBED_LENGTH = 7;

/** What a secret reads as wherever it was scrubbed. */
export const secretPlaceholder = (name: string) => `{{secret:${name}}}`;

const utf8 = new TextEncoder();

/**
 * The base64 characters made of the value's bits alone when it starts `offset`
 * bytes into a 3-byte group: the same in any blob that holds it at that
 * alignment. The characters at its edges share bits with its neighbours.
 */
const base64Cores = (bytes: Uint8Array, offset: number) => {
  const padded = new Uint8Array(offset + bytes.length);
  padded.set(bytes, offset);
  const first = Math.ceil((offset * 4) / 3);
  const end = Math.floor(((offset + bytes.length) * 4) / 3);
  return [Base64.encode(padded), Base64Url.encode(padded)].map((text) => text.slice(first, end));
};

/** Inside a JSON string. */
const jsonEscaped = (text: string) => JSON.stringify(text).slice(1, -1);
/** Inside a JSON string from an encoder that escapes everything past ASCII, like Python's. */
const asciiEscaped = (text: string) =>
  text.replace(
    /[^\u0020-\u007e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * The forms a value is scrubbed in: as it is, shell-quoted, URL-encoded, hex,
 * base64 at each alignment (standard and URL-safe), and each of those inside
 * a JSON string, once or twice escaped (tool output that is itself JSON).
 * Distinct, and none shorter than `MIN_SCRUBBED_LENGTH`.
 */
export const secretForms = (value: string): ReadonlyArray<string> => {
  const bytes = utf8.encode(value);
  const url = encodeURIComponent(value);
  const hex = Hex.encode(bytes);
  const bases = [
    value,
    // `'it'\''s'`, `"say \"hi\""`, and `printf %q`'s backslashes.
    value.replaceAll("'", `'\\''`),
    value.replace(/["\\$`]/g, (char) => `\\${char}`),
    value.replace(/[^A-Za-z0-9_\-.,:/@%+=]/g, (char) => `\\${char}`),
    url,
    url.replaceAll("%20", "+"),
    url.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    hex,
    hex.toUpperCase(),
    ...[0, 1, 2].flatMap((offset) => base64Cores(bytes, offset)),
  ];
  const forms = new Set<string>();
  for (const base of bases) {
    const once = jsonEscaped(base);
    const twice = jsonEscaped(once);
    for (const form of [base, once, twice, asciiEscaped(once), asciiEscaped(twice)]) {
      if (form.length >= MIN_SCRUBBED_LENGTH) forms.add(form);
    }
  }
  return [...forms];
};

export interface SecretTextStream {
  /** The scrubbed text that is safe to pass on now. */
  readonly feed: (text: string) => string;
  /** Everything still held back, scrubbed: no more text is coming. */
  readonly flush: () => string;
}

export interface SecretScrubber {
  /** No secret to hide: everything passes through as it is. */
  readonly empty: boolean;
  readonly text: (text: string) => string;
  /**
   * For text that arrives in pieces. It scans once at least `batch` more
   * characters arrived (by default 64 KiB, or 16 of the longest form), so
   * small pieces don't each rescan what is held back.
   */
  readonly stream: (options?: { readonly batch?: number }) => SecretTextStream;
  /** For UTF-8 bytes that arrive in pieces, such as a request body. Errors on anything else. */
  readonly bytes: () => TransformStream<Uint8Array, Uint8Array>;
}

const BACKSLASH = 0x5c;

/** How many backslashes come right before `at`. */
const backslashesBefore = (text: string, at: number) => {
  let count = 0;
  while (at - count > 0 && text.charCodeAt(at - count - 1) === BACKSLASH) count += 1;
  return count;
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

interface Span {
  readonly start: number;
  end: number;
  readonly names: Array<string>;
}

export const makeSecretScrubber = (secrets: Iterable<SecretValue>): SecretScrubber => {
  const forms: Array<{ readonly form: string; readonly name: string }> = [];
  const seen = new Set<string>();
  for (const { name, value } of secrets) {
    if (value.length < MIN_SCRUBBED_LENGTH) continue;
    for (const form of secretForms(value)) {
      // A value under two names keeps the first: the same text, the same placeholder.
      if (seen.has(form)) continue;
      seen.add(form);
      forms.push({ form, name });
    }
  }
  const longest = forms.reduce((max, { form }) => Math.max(max, form.length), 0);

  /**
   * Every match, overlapping ones merged, in order. A match never splits an
   * escape, so a JSON body stays JSON: one whose first character is escaped
   * takes the backslash too, and one ending in an escaping backslash takes
   * the character it escapes. Until `complete`, a match waiting on that
   * character reaches past the end.
   */
  const spans = (text: string, complete: boolean): Array<Span> => {
    const hits: Array<{ readonly start: number; readonly end: number; readonly name: string }> = [];
    const hit = (start: number, end: number, name: string) => {
      const escapesNext = backslashesBefore(text, end) % 2 === 1;
      hits.push({
        start: backslashesBefore(text, start) % 2 === 1 ? start - 1 : start,
        end: !escapesNext ? end : end < text.length || !complete ? end + 1 : end,
        name,
      });
    };
    for (const { form, name } of forms) {
      // Overlapping matches of one form become one run, so a repetitive value
      // in a long run of itself is one hit, not one per character.
      let run: { start: number; end: number } | null = null;
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        if (run !== null && at < run.end) {
          run.end = at + form.length;
          continue;
        }
        if (run !== null) hit(run.start, run.end, name);
        run = { start: at, end: at + form.length };
      }
      if (run !== null) hit(run.start, run.end, name);
    }
    hits.sort(
      (left, right) =>
        left.start - right.start ||
        right.end - left.end ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    const merged: Array<Span> = [];
    for (const hit of hits) {
      const last = merged.at(-1);
      if (last !== undefined && hit.start < last.end) {
        // A match inside the span adds nothing; one reaching past it adds its name.
        if (hit.end <= last.end) continue;
        last.end = hit.end;
        if (!last.names.includes(hit.name)) last.names.push(hit.name);
      } else {
        merged.push({ start: hit.start, end: hit.end, names: [hit.name] });
      }
    }
    return merged;
  };

  /** `text` up to `until`, each span in it replaced. */
  const render = (text: string, found: ReadonlyArray<Span>, until: number) => {
    let output = "";
    let from = 0;
    for (const span of found) {
      if (span.end > until) break;
      output += text.slice(from, span.start) + span.names.map(secretPlaceholder).join("");
      from = span.end;
    }
    return output + text.slice(from, until);
  };

  const text = (input: string) => {
    if (forms.length === 0) return input;
    const found = spans(input, true);
    return found.length === 0 ? input : render(input, found, input.length);
  };

  const stream: SecretScrubber["stream"] = (options) => {
    const batch = options?.batch ?? Math.max(65_536, 16 * longest);
    let held = "";
    let unscanned = 0;
    /**
     * Passes on what comes before `cut`, but never part of a span, half of a
     * surrogate pair, or a trailing backslash (the next match may start with
     * the character it escapes).
     */
    const release = (cut: number, complete: boolean) => {
      const found = spans(held, complete);
      let until = cut;
      for (let settled = complete; !settled;) {
        settled = true;
        const straddling = found.find((span) => span.start < until && span.end > until);
        if (straddling !== undefined) until = straddling.start;
        while (
          until > 0 &&
          (held.charCodeAt(until - 1) === BACKSLASH || isHighSurrogate(held.charCodeAt(until - 1)))
        ) {
          until -= 1;
          settled = false;
        }
      }
      const output = render(held, found, until);
      held = held.slice(until);
      return output;
    };
    return forms.length === 0
      ? { feed: (input) => input, flush: () => "" }
      : {
          // A form starting before the cut ends inside what is held, so it's whole.
          feed: (input) => {
            held += input;
            unscanned += input.length;
            if (unscanned < batch) return "";
            unscanned = 0;
            return release(Math.max(held.length - (longest - 1), 0), false);
          },
          flush: () => release(held.length, true),
        };
  };

  const bytes = () => {
    if (forms.length === 0) return new TransformStream<Uint8Array, Uint8Array>();
    // Fails on bytes that aren't UTF-8 rather than rewrite them; keeps a byte order mark.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const encoder = new TextEncoder();
    const scrubbing = stream();
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const output = scrubbing.feed(decoder.decode(chunk, { stream: true }));
        if (output !== "") controller.enqueue(encoder.encode(output));
      },
      flush(controller) {
        const output = scrubbing.feed(decoder.decode()) + scrubbing.flush();
        if (output !== "") controller.enqueue(encoder.encode(output));
      },
    });
  };

  return { empty: forms.length === 0, text, stream, bytes };
};
