import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationV2UserInputQuestion, UserInputQuestion } from "@t3tools/contracts";

const decodeRuntimeQuestion = Schema.decodeUnknownSync(UserInputQuestion);
const decodeV2Question = Schema.decodeUnknownSync(OrchestrationV2UserInputQuestion);

describe("native question metadata", () => {
  it("survives both runtime and V2 contract decoding", () => {
    const question = {
      id: "q",
      header: "Choice",
      question: "Which?",
      options: [{ label: "Simple", description: "Simple approach", preview: "## Simple" }],
      native: { isBlocking: false, isSecret: false },
      allowCustomAnswer: false,
      multiSelect: false,
    };
    expect(decodeRuntimeQuestion(question)).toEqual(question);
    expect(decodeV2Question(question)).toEqual(question);
  });
});
