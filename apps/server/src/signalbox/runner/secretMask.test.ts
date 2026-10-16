// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { makeSecretMask, maskingLogger } from "./secretMask.ts";

/** A fresh fake secret per run. */
const fake = (label: string) => `${label}-${crypto.randomUUID()}`;
const KEY = secretPlaceholder("KEY");

describe("secretMask", () => {
  it("masks every value in text with its placeholder, the longest whole", () => {
    const mask = makeSecretMask();
    const short = fake("s3cret");
    mask.add([
      { name: "SHORT", value: short },
      { name: "LONG", value: `${short}-with-tail` },
    ]);

    expect(mask.text(`a ${short}-with-tail and ${short}`)).toBe(
      `a ${secretPlaceholder("LONG")} and ${secretPlaceholder("SHORT")}`,
    );
  });

  it("leaves short values alone: masking them would garble everything and hide nothing", () => {
    const mask = makeSecretMask();
    mask.add([
      { name: "PORT", value: "8080" },
      { name: "FLAG", value: "true" },
      { name: "KEY", value: "abcdef" },
    ]);

    expect(mask.text("PORT=8080 FLAG=true KEY=abcdef")).toBe("PORT=8080 FLAG=true KEY=abcdef");
  });

  it("masks strings deep in plain values and keeps the rest as it is", () => {
    const mask = makeSecretMask();
    const value = fake("hunter2");
    mask.add([{ name: "KEY", value }]);
    const unchanged = { kind: "usage", count: 3 };
    const event = {
      kind: "provider",
      event: { output: [`ran: echo ${value}`, { nested: `${value}!` }], exit: 0 },
      unchanged,
    };

    const masked = mask.value(event);

    expect(masked).toEqual({
      kind: "provider",
      event: { output: [`ran: echo ${KEY}`, { nested: `${KEY}!` }], exit: 0 },
      unchanged,
    });
    expect(masked.unchanged).toBe(unchanged);
    expect(mask.value(unchanged)).toBe(unchanged);
  });

  it("masks a value in a session row, however the row encodes it", () => {
    const mask = makeSecretMask();
    const quoted = `pa"ss\\word\nline-${crypto.randomUUID()}`;
    const plain = fake("plain");
    mask.add([
      { name: "QUOTED", value: quoted },
      { name: "KEY", value: plain },
    ]);
    const row = JSON.stringify({
      type: "tool_result",
      content: `got ${quoted} and ${plain}, ${btoa(`KEY=${plain}`)}`,
    });

    const masked = mask.json(row);

    expect(masked).not.toContain(plain);
    expect(masked).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(masked).not.toContain(btoa(`KEY=${plain}`));
    expect(JSON.parse(masked)).toMatchObject({
      type: "tool_result",
      content: expect.stringContaining(`got ${secretPlaceholder("QUOTED")} and ${KEY}, `),
    });
    expect(mask.json('{"untouched":true}')).toBe('{"untouched":true}');
    expect(JSON.parse(mask.json(JSON.stringify({ [plain]: 1 })))).toEqual({ [KEY]: 1 });
  });

  it.effect("masks what the Runner logs, failures included", () =>
    Effect.gen(function* () {
      const mask = makeSecretMask();
      const value = fake("logged");
      mask.add([{ name: "KEY", value }]);
      const lines: Array<unknown> = [];
      const collector = Logger.make((options) => void lines.push(options.message));

      yield* Effect.logError(`command failed for ${value}`, new Error(`exit 1: ${value}`)).pipe(
        Effect.provide(Logger.layer([maskingLogger(mask, collector)])),
      );
      yield* Effect.logWarning("plain").pipe(
        Effect.andThen(Effect.die(new Error(`boom ${value}`))),
        Effect.catchCause((cause) => Effect.logError("died", cause)),
        Effect.provide(Logger.layer([maskingLogger(mask, collector)])),
      );

      expect(JSON.stringify(lines)).not.toContain(value);
      expect(JSON.stringify(lines)).toContain(KEY);
    }),
  );
});
