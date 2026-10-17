import { describe, expect, it } from "vite-plus/test";
import { nativeCodexQuestions } from "./nativeCodexQuestions.ts";

describe("native Codex questions", () => {
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
