import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { makeSecretMask, maskingLogger } from "./secretMask.ts";

describe("secretMask", () => {
  it("masks every value in text, the longest first", () => {
    const mask = makeSecretMask();
    mask.add(["s3cret-token", "s3cret-token-with-tail"]);

    expect(mask.text("a s3cret-token-with-tail and s3cret-token")).toBe("a *** and ***");
  });

  it("leaves short values alone: masking them would garble everything and hide nothing", () => {
    const mask = makeSecretMask();
    mask.add(["true", "8080", "abcdef"]);

    expect(mask.text("PORT=8080 FLAG=true KEY=abcdef")).toBe("PORT=8080 FLAG=true KEY=abcdef");
  });

  it("masks strings deep in plain values and keeps the rest as it is", () => {
    const mask = makeSecretMask();
    mask.add(["hunter2-value"]);
    const unchanged = { kind: "usage", count: 3 };
    const value = {
      kind: "provider",
      event: { output: ["ran: echo hunter2-value", { nested: "hunter2-value!" }], exit: 0 },
      unchanged,
    };

    const masked = mask.value(value);

    expect(masked).toEqual({
      kind: "provider",
      event: { output: ["ran: echo ***", { nested: "***!" }], exit: 0 },
      unchanged,
    });
    expect(masked.unchanged).toBe(unchanged);
    expect(mask.value(unchanged)).toBe(unchanged);
  });

  it("masks a value inside JSON text, even where JSON escapes it", () => {
    const mask = makeSecretMask();
    const quoted = 'pa"ss\\word\nline';
    mask.add([quoted, "plain-secret"]);
    const row = JSON.stringify({ type: "tool_result", content: `got ${quoted} and plain-secret` });

    const masked = mask.json(row);

    expect(masked).not.toContain("plain-secret");
    expect(masked).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(JSON.parse(masked)).toEqual({ type: "tool_result", content: "got *** and ***" });
    expect(mask.json('{"untouched":true}')).toBe('{"untouched":true}');
  });

  it.effect("masks what the Runner logs, failures included", () =>
    Effect.gen(function* () {
      const mask = makeSecretMask();
      mask.add(["logged-secret"]);
      const lines: Array<unknown> = [];
      const collector = Logger.make((options) => void lines.push(options.message));

      yield* Effect.logError(
        "command failed for logged-secret",
        new Error("exit 1: logged-secret"),
      ).pipe(Effect.provide(Logger.layer([maskingLogger(mask, collector)])));
      yield* Effect.logWarning("plain").pipe(
        Effect.andThen(Effect.die(new Error("boom logged-secret"))),
        Effect.catchCause((cause) => Effect.logError("died", cause)),
        Effect.provide(Logger.layer([maskingLogger(mask, collector)])),
      );

      expect(JSON.stringify(lines)).not.toContain("logged-secret");
      expect(JSON.stringify(lines)).toContain("***");
    }),
  );
});
