import type { AskKitQuestion } from "@t3tools/shared/askKit";
import { decodeAskKitAnswer, encodeAskKitAnswer } from "@t3tools/shared/askKitAnswer";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

const options = (...values: ReadonlyArray<unknown>) =>
  values.map((value, index) => ({ label: `Option ${index}`, value }));

const ask = (
  component: string,
  props: unknown,
  changes: Partial<AskKitQuestion> = {},
): AskKitQuestion => ({
  options: options("a", "b", "c"),
  recommendation: null,
  surface: { kind: "kit", component, props },
  ...changes,
});

const answer = (question: AskKitQuestion, value: unknown, comment?: string) =>
  decodeAskKitAnswer(question, comment === undefined ? { value } : { value, comment });

const failureCode = (result: ReturnType<typeof answer>) =>
  Result.isFailure(result) ? result.failure.code : null;

const slider = ask("slider", { min: 0, max: 1, step: 0.1 }, { options: [] });

describe("ask kit answers", () => {
  it("names options by value regardless of key order", () => {
    const question = ask(
      "choices",
      {},
      { options: options({ plan: "a", seats: 2 }, { plan: "b", seats: 5 }), multiSelect: true },
    );
    expect(
      answer(question, [
        { seats: 5, plan: "b" },
        { seats: 2, plan: "a" },
      ]),
    ).toEqual(Result.succeed({ component: "choices", selected: [0, 1] }));
    expect(encodeAskKitAnswer(question, { component: "choices", selected: [1] })).toEqual([
      { plan: "b", seats: 5 },
    ]);
  });

  it("rejects selections outside the options or repeated", () => {
    const multi = ask("choices", {}, { multiSelect: true });
    expect(failureCode(answer(ask("choices", {}), "z"))).toBe("answer-unknown-option");
    expect(failureCode(answer(multi, ["a", "a"]))).toBe("answer-repeated");
    expect(failureCode(answer(multi, []))).toBe("answer-empty");
  });

  it("requires a ranking to place every option once", () => {
    const ranking = ask("ranking", {});
    expect(answer(ranking, ["c", "a", "b"])).toEqual(
      Result.succeed({ component: "ranking", order: [2, 0, 1] }),
    );
    expect(failureCode(answer(ranking, ["c", "a"]))).toBe("answer-incomplete");
    expect(encodeAskKitAnswer(ranking, { component: "ranking", order: [1, 2, 0] })).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("keeps slider answers inside the range and on its steps", () => {
    expect(answer(slider, 0.3)).toEqual(Result.succeed({ component: "slider", value: 0.3 }));
    expect(failureCode(answer(slider, 1.1))).toBe("answer-out-of-range");
    expect(failureCode(answer(slider, 0.35))).toBe("answer-off-step");
    expect(failureCode(answer(slider, "0.3"))).toBe("answer-invalid");
  });

  it("finds grid points far from zero, where step counts drift", () => {
    const far = ask("slider", { min: 999_999_999_999, max: 1e12, step: 0.1 }, { options: [] });
    for (const value of [999_999_999_999, 999_999_999_999.1, 999_999_999_999.7, 1e12]) {
      expect(answer(far, value)).toEqual(Result.succeed({ component: "slider", value }));
    }
    expect(failureCode(answer(far, 999_999_999_999.15))).toBe("answer-off-step");
    expect(failureCode(answer(far, 999_999_999_999.05))).toBe("answer-off-step");

    const signed = ask("slider", { min: -1, max: 1, step: 0.25 }, { options: [] });
    expect(answer(signed, -0.75)).toEqual(Result.succeed({ component: "slider", value: -0.75 }));
    expect(failureCode(answer(signed, -0.8))).toBe("answer-off-step");
    expect(failureCode(answer(signed, 1.25))).toBe("answer-out-of-range");
  });

  it("limits text answers and treats blanks as unanswered", () => {
    const text = ask("text", { maxLength: 5 }, { options: [] });
    expect(answer(text, "short")).toEqual(Result.succeed({ component: "text", text: "short" }));
    expect(failureCode(answer(text, "   "))).toBe("answer-empty");
    expect(failureCode(answer(text, "too long"))).toBe("answer-too-long");
  });

  it("keeps a comment beside a structured answer without checking it", () => {
    expect(answer(slider, 0.5, "")).toEqual(Result.succeed({ component: "slider", value: 0.5 }));
    expect(answer(ask("choices", {}), "b", "but only if it ships this week")).toEqual(
      Result.succeed({ component: "choices", selected: [1] }),
    );
  });

  it("answers any kit component in words only through a null value and a comment", () => {
    for (const question of [
      ask("choices", {}),
      ask("ranking", {}),
      ask("text", {}, { options: [] }),
      slider,
    ]) {
      expect(answer(question, null, "Neither, do the third thing")).toEqual(
        Result.succeed({ component: "words-only" }),
      );
      expect(failureCode(answer(question, null, "  "))).toBe("answer-empty");
      expect(failureCode(answer(question, null))).toBe("answer-empty");
      expect(encodeAskKitAnswer(question, { component: "words-only" })).toBeNull();
    }
  });

  it("lets a broken kit surface take words only, never unchecked values", () => {
    const broken = ask("slider", { min: 5, max: 1, step: 1 }, { options: [] });
    expect(failureCode(answer(broken, 3))).toBe("answer-invalid");
    expect(failureCode(answer(broken, { anything: true }))).toBe("answer-invalid");
    expect(answer(broken, null, "Make it about 3")).toEqual(
      Result.succeed({ component: "words-only" }),
    );
  });

  it("picks a null-valued option on a legacy surface without a comment", () => {
    const native = ask("native-question", { header: "Pick" }, { options: options(null, "b") });
    expect(answer(native, null)).toEqual(Result.succeed({ component: "legacy", value: null }));
    expect(answer(native, null, "")).toEqual(Result.succeed({ component: "legacy", value: null }));
    expect(encodeAskKitAnswer(native, { component: "legacy", value: null })).toBeNull();
  });

  it("answers legacy surfaces with any JSON, as their renderers allow", () => {
    const native = ask("native-question", { header: "Pick" });
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 40; depth++) deep = [deep];
    for (const value of ["something the person typed", deep, { a: [1, null, false] }]) {
      expect(answer(native, value)).toEqual(Result.succeed({ component: "legacy", value }));
    }
    const html: AskKitQuestion = { options: [], surface: { kind: "html", html: "<form/>" } };
    expect(answer(html, { picked: "b" })).toEqual(
      Result.succeed({ component: "legacy", value: { picked: "b" } }),
    );
    expect(failureCode(answer(native, Number.POSITIVE_INFINITY))).toBe("json-invalid");
    expect(failureCode(answer(native, undefined))).toBe("json-invalid");
  });

  it("rejects cyclic values but accepts parts shared without a cycle", () => {
    const native = ask("native-question", { header: "Pick" });
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const ring: unknown[] = [1];
    ring.push([ring]);
    expect(failureCode(answer(native, loop))).toBe("json-invalid");
    expect(failureCode(answer(native, { wrapped: ring }))).toBe("json-invalid");

    const shared = { a: [1, 2] };
    const reused = { x: shared, y: [shared, { z: shared }] };
    expect(answer(native, reused)).toEqual(Result.succeed({ component: "legacy", value: reused }));

    // Sixty stacked diamonds reach the bottom 2^60 ways; each part is checked once.
    let diamond: unknown = "bottom";
    for (let level = 0; level < 60; level++) diamond = [diamond, diamond];
    expect(answer(native, diamond)).toEqual(
      Result.succeed({ component: "legacy", value: diamond }),
    );
  });
});
