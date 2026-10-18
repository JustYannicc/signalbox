import { AskKitProblem } from "@t3tools/contracts/askKit";
import { type AskKitQuestion, askKitFontFamily, resolveAskKit } from "@t3tools/shared/askKit";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

const decodeProblem = Schema.decodeSync(AskKitProblem);

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

const codes = (question: AskKitQuestion) =>
  resolveAskKit(question).problems.map((problem) => problem.code);

const pngData = "data:image/png;base64,iVBORw0KGgo=";
const compare = (preview: unknown) =>
  ask(
    "compare",
    {
      panes: [
        { option: 0, preview },
        { option: 1, preview: { kind: "html", title: "B", html: "<p>B</p>" } },
      ],
    },
    { options: options("a", "b") },
  );

describe("ask kit surfaces", () => {
  it("styles options in place with device fonts and hex colours", () => {
    const question = ask("choices", {
      optionStyles: [
        { option: 0, font: "Georgia", color: "#1d4ed8" },
        { option: 2, font: "ui-monospace" },
      ],
    });
    expect(resolveAskKit(question)).toEqual({
      spec: {
        component: "choices",
        multiSelect: false,
        looks: [{ font: "Georgia", color: "#1d4ed8" }, null, { font: "ui-monospace" }],
      },
      problems: [],
    });
    expect(askKitFontFamily("Georgia")).toBe('"Georgia", system-ui, sans-serif');
    expect(askKitFontFamily("ui-monospace")).toBe("ui-monospace");
  });

  it("rejects fonts and colours that could load or inject CSS", () => {
    for (const style of [
      { option: 0, font: "x); background: url(https://evil" },
      { option: 0, font: '"Inter", serif' },
      { option: 0, color: "red" },
      { option: 0, color: "#12345" },
    ]) {
      const resolution = resolveAskKit(ask("choices", { optionStyles: [style] }));
      expect(resolution.spec).toEqual({ component: "invalid" });
      expect(resolution.problems[0]?.code).toBe("props-invalid");
      expect(resolution.problems[0]?.path.slice(0, 4)).toEqual([
        "surface",
        "props",
        "optionStyles",
        0,
      ]);
    }
  });

  it("names the property an agent misspelled instead of dropping it", () => {
    expect(resolveAskKit(ask("choices", { optionStyle: [] })).problems).toEqual([
      {
        code: "props-invalid",
        path: ["surface", "props", "optionStyle"],
        message: "Unknown property.",
      },
    ]);
  });

  it("checks option references cover the options exactly once", () => {
    expect(codes(ask("choices", { optionStyles: [{ option: 3, color: "#fff" }] }))).toEqual([
      "option-out-of-range",
    ]);
    expect(
      codes(
        ask("compare", {
          panes: [
            { option: 0, preview: { kind: "html", title: "A", html: "<p>A</p>" } },
            { option: 0, preview: { kind: "html", title: "B", html: "<p>B</p>" } },
          ],
        }),
      ),
    ).toEqual(["option-repeated", "pane-missing", "pane-missing"]);
    expect(codes(ask("ranking", {}, { options: options("a", { id: 1 }, { id: 1 }) }))).toEqual([
      "option-values-repeated",
    ]);
  });

  it("reserves null option values on kit components for words-only answers", () => {
    expect(codes(ask("choices", {}, { options: options("a", null) }))).toEqual([
      "option-value-null",
    ]);
    expect(resolveAskKit(ask("choices", {}, { options: options("a", null) })).spec).toEqual({
      component: "invalid",
    });
  });

  it("shows compare images from https, thread attachments or small inline data", () => {
    const image = (source: unknown) => compare({ kind: "image", image: source, alt: "A" });
    expect(codes(image({ source: "https", url: "https://example.com/a.png" }))).toEqual([]);
    expect(
      codes(image({ source: "attachment", attachmentId: "att_123", mimeType: "image/png" })),
    ).toEqual([]);
    expect(codes(image({ source: "data", dataUrl: pngData }))).toEqual([]);
    for (const rejected of [
      { source: "https", url: "http://example.com/a.png" },
      { source: "https", url: "javascript:alert(1)" },
      { source: "attachment", attachmentId: "../secrets", mimeType: "image/png" },
      { source: "attachment", attachmentId: "att_123", mimeType: "image/svg+xml" },
      { source: "data", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
      { source: "data", dataUrl: `data:image/png;base64,${"A".repeat(48_000)}` },
    ]) {
      expect(codes(image(rejected))).toEqual(["props-invalid"]);
    }
  });

  it("points live previews at a thread's preview tab, with a still for when it closes", () => {
    const still = { image: { source: "data", dataUrl: pngData }, alt: "Last frame" };
    expect(
      codes(compare({ kind: "thread-preview", threadId: "thread-1", tabId: "tab-1", still })),
    ).toEqual([]);
    expect(codes(compare({ kind: "thread-preview", threadId: "thread-1" }))).toEqual([
      "props-invalid",
    ]);
  });

  it("requires a slider grid that reaches max in bounded steps", () => {
    const slider = (props: unknown) => ask("slider", props, { options: [] });
    expect(codes(slider({ min: 0, max: 1, step: 0.1, startLabel: "Low" }))).toEqual([]);
    expect(codes(slider({ min: 5, max: 5, step: 1 }))).toEqual(["slider-range-invalid"]);
    expect(codes(slider({ min: 0, max: 10, step: 3 }))).toEqual(["slider-step-invalid"]);
    expect(codes(slider({ min: 0, max: 1e6, step: 1 }))).toEqual(["slider-step-invalid"]);
    expect(codes(slider({ min: 0, max: 10, step: 0 }))).toEqual(["props-invalid"]);
    expect(codes(ask("slider", { min: 0, max: 10, step: 1 }))).toEqual(["options-unexpected"]);
  });

  it("refuses slider steps that leave no step or sit below rounding error", () => {
    const slider = (props: unknown) => ask("slider", props, { options: [] });
    // One "step" of 1e12 over a range of 1 rounds to zero steps.
    expect(codes(slider({ min: 0, max: 1, step: 1e12 }))).toEqual(["slider-step-invalid"]);
    expect(codes(slider({ min: 0, max: 1, step: 0.6 }))).toEqual(["slider-step-invalid"]);
    // At 1e12 a double resolves about 1e-4, so 1e-4 steps can't be told apart from rounding.
    expect(codes(slider({ min: 1e12 - 0.001, max: 1e12, step: 0.0001 }))).toEqual([
      "slider-step-invalid",
    ]);
    expect(codes(slider({ min: 999_999_999_999, max: 1e12, step: 0.1 }))).toEqual([]);
    expect(codes(slider({ min: -1, max: 1, step: 0.25 }))).toEqual([]);
  });

  it("rejects component shapes that can't answer the way the agent meant", () => {
    expect(codes(ask("ranking", {}, { multiSelect: true }))).toEqual(["multi-select-unsupported"]);
    expect(codes(ask("choices", {}, { options: [] }))).toEqual(["options-missing"]);
    expect(codes(ask("choices", {}, { recommendation: "z" }))).toEqual(["recommendation-invalid"]);
    expect(codes(ask("choices", {}, { recommendation: "b" }))).toEqual([]);
  });

  it("bounds kit JSON so later runtime use stays safe", () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 40; depth++) deep = [deep];
    expect(codes(ask("choices", {}, { options: options("a", deep) }))).toEqual(["json-too-large"]);
    expect(codes(ask("choices", {}, { options: options("a", Number.NaN) }))).toEqual([
      "json-invalid",
    ]);
  });

  it("adds no rules to surfaces it doesn't own", () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 40; depth++) deep = [deep];
    const awkward = options(null, "same", "same", deep);
    for (const component of ["native-question", "automation"]) {
      expect(
        resolveAskKit(
          ask(
            component,
            { header: "Pick", anything: true },
            { options: awkward, multiSelect: true },
          ),
        ),
      ).toEqual({
        spec: { component: "legacy", reason: "unknown-component", multiSelect: true },
        problems: [],
      });
    }
    expect(resolveAskKit({ options: awkward, surface: { kind: "html", html: "<p/>" } })).toEqual({
      spec: { component: "legacy", reason: "html", multiSelect: false },
      problems: [],
    });
  });

  it("encodes problems in the contract schema", () => {
    for (const problem of resolveAskKit(ask("choices", { optionStyle: [] })).problems) {
      expect(decodeProblem(problem)).toEqual(problem);
    }
  });
});
