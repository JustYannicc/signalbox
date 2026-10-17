// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "vite-plus/test";

import {
  makeSecretScrubber,
  MIN_SCRUBBED_LENGTH,
  secretForms,
  secretPlaceholder,
} from "./SecretScrubber.ts";

/** A fresh fake secret for each run, so no test ever holds a real one. */
const fake = (label: string) => `${label}-${crypto.randomUUID()}`;

const KEY = secretPlaceholder("KEY");

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const utf8 = (text: string) => new TextEncoder().encode(text);

/** `text` fed in the pieces `cuts` makes, then flushed. */
const streamed = (
  scrubber: ReturnType<typeof makeSecretScrubber>,
  text: string,
  cuts: number[],
  // Scans at every piece by default, so the holdback is what's under test.
  batch = 1,
) => {
  const stream = scrubber.stream({ batch });
  let output = "";
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    output += stream.feed(text.slice(from, cut));
    from = cut;
  }
  return output + stream.flush();
};

describe("SecretScrubber", () => {
  it("replaces a value with its placeholder, and touches nothing else", () => {
    const value = fake("sk-live");
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const body = JSON.stringify({
      messages: [{ role: "user", content: [{ type: "tool_result", content: `${value}\n` }] }],
    });

    const scrubbed = scrubber.text(body);

    expect(scrubbed).not.toContain(value);
    expect(JSON.parse(scrubbed)).toEqual({
      messages: [{ role: "user", content: [{ type: "tool_result", content: `${KEY}\n` }] }],
    });
    // Byte for byte the same without a secret in it, so prompt caching holds.
    const clean = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    expect(scrubber.text(clean)).toBe(clean);
    expect(scrubber.text(body)).toBe(scrubbed);
  });

  it("masks each encoding a tool might print the value in", () => {
    // Quotes, a backslash, a space, a newline and non-ASCII, so every form differs.
    const value = `p"a\\ss w'o$rd\né-${crypto.randomUUID().slice(0, 8)}`;
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const bytes = utf8(value);
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const encoded = {
      raw: value,
      json: JSON.stringify(value).slice(1, -1),
      jsonTwice: JSON.stringify(JSON.stringify(value)).slice(1, -1),
      jsonAscii: JSON.stringify(value)
        .slice(1, -1)
        .replace(
          /[^\u0020-\u007e]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      url: encodeURIComponent(value),
      form: encodeURIComponent(value).replaceAll("%20", "+"),
      hex,
      hexUpper: hex.toUpperCase(),
      singleQuoted: `'${value.replaceAll("'", `'\\''`)}'`,
      doubleQuoted: `"${value.replace(/["\\$`]/g, (char) => `\\${char}`)}"`,
      base64: base64(bytes),
      base64Url: base64(bytes).replaceAll("+", "-").replaceAll("/", "_"),
    };
    for (const [form, text] of Object.entries(encoded)) {
      const scrubbed = scrubber.text(`before ${text} after`);
      expect(scrubbed, form).toContain(KEY);
      expect(scrubbed.includes(text), form).toBe(false);
    }
  });

  it("masks a value base64-encoded inside a bigger blob, at every byte offset", () => {
    const value = fake("token");
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    for (const offset of [0, 1, 2, 3, 4, 5]) {
      const prefix = `${"x".repeat(offset)}API_KEY=`;
      const blob = base64(utf8(`${prefix}${value}\nOTHER=1\n`));
      const [before = "", after = ""] = scrubber.text(blob).split(KEY);
      // Every base64 character made of the value's bits alone is gone; at most the
      // two at its edges, which share bits with its neighbours, are left.
      const start = prefix.length;
      const end = start + value.length;
      expect(blob.startsWith(before) && blob.endsWith(after), `offset ${offset}`).toBe(true);
      expect(before.length, `offset ${offset}`).toBeLessThanOrEqual(Math.ceil((start * 4) / 3));
      expect(blob.length - after.length, `offset ${offset}`).toBeGreaterThanOrEqual(
        Math.floor((end * 4) / 3),
      );
    }
  });

  it("covers every form secretForms lists", () => {
    const value = `a'b"c\\d e-${crypto.randomUUID().slice(0, 6)}`;
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const forms = secretForms(value);
    expect(new Set(forms).size).toBe(forms.length);
    for (const form of forms) {
      expect(form.length).toBeGreaterThanOrEqual(MIN_SCRUBBED_LENGTH);
      expect(scrubber.text(`[${form}]`), form).toBe(`[${KEY}]`);
    }
  });

  it("leaves values too short to hide anything alone", () => {
    const scrubber = makeSecretScrubber([
      { name: "PORT", value: "8080" },
      { name: "FLAG", value: "abcdef" },
    ]);
    expect(scrubber.empty).toBe(true);
    expect(scrubber.text("PORT=8080 FLAG=abcdef")).toBe("PORT=8080 FLAG=abcdef");
  });

  it("can scrub nonempty short secrets without changing the default minimum", () => {
    const secrets = [
      { name: "ONE_BYTE", value: "1" },
      { name: "THREE_BYTES", value: "猫" },
      { name: "SEVEN_BYTES", value: "éééa" },
    ];
    expect(secrets.map(({ value }) => utf8(value).byteLength)).toEqual([1, 3, 7]);
    expect(secrets.map(({ name, value }) => makeSecretScrubber([{ name, value }]).empty)).toEqual([
      true,
      true,
      true,
    ]);

    for (const secret of secrets) {
      const scrubber = makeSecretScrubber([secret], { minLength: 1 });
      expect(scrubber.empty).toBe(false);
      expect(scrubber.text(secret.value)).toContain(secretPlaceholder(secret.name));
      for (let cut = 0; cut <= secret.value.length; cut += 1) {
        expect(streamed(scrubber, secret.value, [cut])).toBe(scrubber.text(secret.value));
      }
    }

    const empty = { name: "EMPTY", value: "" };
    expect(makeSecretScrubber([empty], { minLength: 1 }).empty).toBe(true);
    expect(secretForms(empty.value, { minLength: 1 })).toEqual([]);
    expect(secretForms("x", { minLength: 1 })).not.toContain("");
  });

  it("scrubs short unicode secrets in every generated encoding across chunks", () => {
    const secret = { name: "UNICODE", value: "猫" };
    const scrubber = makeSecretScrubber([secret], { minLength: 1 });
    const forms = secretForms(secret.value, { minLength: 1 });
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.every((form) => form.length > 0)).toBe(true);

    for (const form of forms) {
      const scrubbed = scrubber.text(form);
      expect(scrubbed, form).toBe(secretPlaceholder(secret.name));
      for (let cut = 0; cut <= form.length; cut += 1) {
        expect(streamed(scrubber, form, [cut]), `${form} at ${cut}`).toBe(scrubbed);
      }
    }
  });

  it("merges overlapping short secrets when the minimum is lowered", () => {
    const scrubber = makeSecretScrubber(
      [
        { name: "FIRST", value: "abc" },
        { name: "SECOND", value: "bcd" },
      ],
      { minLength: 1 },
    );

    expect(scrubber.text("abcd")).toBe(
      `${secretPlaceholder("FIRST")}${secretPlaceholder("SECOND")}`,
    );
    expect(streamed(scrubber, "abcd", [1, 2, 3])).toBe(scrubber.text("abcd"));
  });

  it("masks overlapping secrets whole, so no tail of either is left", () => {
    const shared = crypto.randomUUID().slice(0, 8);
    const first = `first-${shared}`;
    const second = `${shared}-second`;
    const scrubber = makeSecretScrubber([
      { name: "A", value: first },
      { name: "B", value: second },
    ]);

    expect(scrubber.text(`<first-${shared}-second>`)).toBe(
      `<${secretPlaceholder("A")}${secretPlaceholder("B")}>`,
    );
    expect(scrubber.text(`<${first}> <${second}>`)).toBe(
      `<${secretPlaceholder("A")}> <${secretPlaceholder("B")}>`,
    );
  });

  it("masks a secret that is a prefix of another, and the longer one whole", () => {
    const short = fake("prefix");
    const long = `${short}-and-more`;
    const scrubber = makeSecretScrubber([
      { name: "SHORT", value: short },
      { name: "LONG", value: long },
    ]);

    expect(scrubber.text(`${long} ${short}!`)).toBe(
      `${secretPlaceholder("LONG")} ${secretPlaceholder("SHORT")}!`,
    );
  });

  it("is the same text whichever way a body is split into chunks", () => {
    const short = fake("short");
    const long = `${short}-${crypto.randomUUID()}`;
    const scrubber = makeSecretScrubber([
      { name: "SHORT", value: short },
      { name: "LONG", value: long },
    ]);
    const body = JSON.stringify({
      input: [{ type: "function_call_output", output: `${long}\n${short}\n${btoa(long)}` }],
    });
    const whole = scrubber.text(body);
    expect(whole).not.toContain(short);

    for (let cut = 0; cut <= body.length; cut += 1) {
      expect(streamed(scrubber, body, [cut]), `split at ${cut}`).toBe(whole);
    }
    // Three pieces, around the first value.
    const at = body.indexOf(long);
    for (let first = at; first < at + long.length; first += 1) {
      for (let second = first; second < at + long.length + 3; second += 1) {
        expect(streamed(scrubber, body, [first, second]), `split at ${first}, ${second}`).toBe(
          whole,
        );
      }
    }
    // One character at a time.
    expect(
      streamed(
        scrubber,
        body,
        Array.from({ length: body.length }, (_, index) => index),
      ),
    ).toBe(whole);
  });

  it("scrubs a byte stream, even where a chunk splits a character", async () => {
    const value = `é-${fake("bytes")}-ü`;
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const bytes = utf8(JSON.stringify({ content: `ok ${value} ok` }));
    const chunks = Array.from({ length: bytes.length }, (_, index) =>
      bytes.slice(index, index + 1),
    );
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const text = await new Response(source.pipeThrough(scrubber.bytes())).text();

    expect(JSON.parse(text)).toEqual({ content: `ok ${KEY} ok` });
  });

  it("scrubs a long run of a repetitive value in linear time, whichever way it streams", () => {
    const scrubber = makeSecretScrubber([{ name: "ZEROS", value: "00000000" }]);
    const body = `a${"0".repeat(1_000_000)}b`;
    const pieces = Array.from({ length: 1000 }, (_, index) => (index + 1) * 1000);

    const started = performance.now();
    expect(streamed(scrubber, body, pieces, 65_536)).toBe(`a${secretPlaceholder("ZEROS")}b`);
    expect(scrubber.text(body)).toBe(`a${secretPlaceholder("ZEROS")}b`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("gives the same text in big batches as piece by piece", () => {
    const value = fake("batched");
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const body = `${"x".repeat(100_000)}${value}${"y".repeat(100_000)}${value}`;
    const pieces = Array.from({ length: 200 }, (_, index) => (index + 1) * 1003);

    expect(streamed(scrubber, body, pieces, 65_536)).toBe(scrubber.text(body));
    expect(streamed(scrubber, body, pieces)).toBe(scrubber.text(body));
  });

  it("keeps a JSON body JSON when a match sits against an escape", () => {
    // `n`, `t`, `u` and `"` all follow a backslash in JSON: the text holds `\n` + the rest.
    const value = `npm_${crypto.randomUUID().slice(0, 8)}`;
    const quote = `ab"${crypto.randomUUID().slice(0, 8)}`;
    const scrubber = makeSecretScrubber([
      { name: "NPM", value },
      // A value ending in a backslash, so its raw form can end mid-escape.
      { name: "SLASH", value: `${crypto.randomUUID().slice(0, 8)}\\` },
      { name: "QUOTE", value: quote },
    ]);
    const bodies = [
      JSON.stringify({ t: `line\n${value.slice(1)}`, u: `${value}` }),
      JSON.stringify({ t: `${quote}`, u: `x${quote}"` }),
      JSON.stringify({ t: `${"\\".repeat(3)}${value}` }),
    ];
    for (const body of bodies) {
      const scrubbed = scrubber.text(body);
      expect(() => JSON.parse(scrubbed), scrubbed).not.toThrow();
      expect(scrubbed.includes(value), scrubbed).toBe(false);
      for (let cut = 0; cut <= body.length; cut += 1) {
        expect(streamed(scrubber, body, [cut]), `${body} at ${cut}`).toBe(scrubbed);
      }
    }
  });

  it("never splits a character at a chunk's cut", async () => {
    const value = fake("emoji");
    const scrubber = makeSecretScrubber([{ name: "KEY", value }]);
    const body = JSON.stringify({ content: `${"🔑".repeat(200)} ${value} ${"😀".repeat(200)}` });
    const bytes = utf8(body);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    });

    const text = await new Response(source.pipeThrough(scrubber.bytes())).text();

    expect(text).toBe(scrubber.text(body));
    expect(text).not.toContain("\uFFFD");
  });

  it("refuses bytes that aren't UTF-8 rather than rewrite them", async () => {
    const scrubber = makeSecretScrubber([{ name: "KEY", value: fake("binary") }]);
    const source = new Blob([new Uint8Array([255, 254, 0, 128, 65])]).stream();

    await expect(new Response(source.pipeThrough(scrubber.bytes())).text()).rejects.toThrow();
  });
});
