import { describe, expect, it } from "vite-plus/test";
import { nativeCodexQuestions } from "./nativeCodexQuestions.ts";

describe("native Codex questions", () => {
  it("keeps the recommendation separate from a custom editor's initial answer", () => {
    const [question] = nativeCodexQuestions(
      [
        {
          id: "city",
          header: "City",
          question: "Which city?",
          options: [
            { label: "Bern", description: "Capital" },
            { label: "Zurich (Recommended)", description: "Suggested" },
          ],
        },
      ],
      true,
    );
    expect(question?.native?.recommendation).toBe("Zurich (Recommended)");
    expect(question?.initialAnswer).toBeUndefined();
    expect(
      nativeCodexQuestions([{ id: "open", header: "Open", question: "Which?" }], true)[0]?.native
        ?.recommendation,
    ).toBeUndefined();
  });
  it("keeps explicit Other, secret and blocking hints", () => {
    const questions = nativeCodexQuestions(
      [
        {
          id: "q",
          header: "Choice",
          question: "Choose",
          isOther: false,
          isSecret: true,
          options: [{ label: "Yes", description: "Do it" }],
        },
      ],
      false,
    );
    expect(questions[0]).toMatchObject({
      allowCustomAnswer: false,
      native: { isSecret: true, isBlocking: false },
    });
    expect(
      nativeCodexQuestions(
        [{ id: "q", header: "Choice", question: "Choose", isOther: true }],
        true,
      )[0],
    ).toMatchObject({ allowCustomAnswer: true, native: { isBlocking: true } });
  });
});
