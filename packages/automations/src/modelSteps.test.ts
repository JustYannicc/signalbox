import { describe, expect, it } from "@effect/vitest";

import { modelResult } from "@signalbox/automations/modelSteps";

describe("model step outputs", () => {
  it("checks nested extraction shapes before returning data", () => {
    const options = {
      schema: { title: "string", ready: "boolean", lines: [{ amount: "number" }] },
    };
    expect(
      modelResult("extract", options, '{"title":"Invoice","ready":true,"lines":[{"amount":42}]}'),
    ).toEqual({
      ok: true,
      value: { title: "Invoice", ready: true, lines: [{ amount: 42 }] },
    });
    for (const text of [
      '{"title":"Invoice","ready":true,"lines":[{"amount":"42"}]}',
      '{"title":"Invoice","ready":true}',
      '{"title":"Invoice","ready":"yes","lines":[]}',
      '"not an object"',
      "not JSON",
    ])
      expect(modelResult("extract", options, text).ok).toBe(false);
  });

  it("refuses unsupported shape descriptions instead of accepting unchecked output", () => {
    expect(modelResult("extract", { schema: { count: "integerish" } }, '{"count":42}').ok).toBe(
      false,
    );
    expect(modelResult("extract", { schema: { lines: [] } }, '{"lines":[]}').ok).toBe(false);
  });

  it("retains the no-schema extraction form", () => {
    expect(modelResult("extract", {}, '{"count":42}')).toEqual({ ok: true, value: { count: 42 } });
    expect(modelResult("extract", {}, '"unstructured text"').ok).toBe(false);
  });

  it("requires a boolean verdict and a nonempty reason, retaining the existing outcome form", () => {
    expect(modelResult("judge", {}, '{"verdict":false,"reason":"The check failed."}')).toEqual({
      ok: true,
      value: { verdict: false, reason: "The check failed." },
    });
    for (const text of [
      '{"verdict":"true","reason":"Done"}',
      '{"verdict":true}',
      '{"verdict":true,"reason":" "}',
      "yes",
    ])
      expect(modelResult("judge", {}, text).ok).toBe(false);
    expect(modelResult("judge", { outcomes: ["bug", "noise"] }, "**Bug**")).toEqual({
      ok: true,
      value: "bug",
    });
    expect(modelResult("judge", { outcomes: ["bug", "noise"] }, "neither").ok).toBe(false);
  });
});
