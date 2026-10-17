import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export function nativeCodexQuestions(
  questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>,
  isBlocking: boolean,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  return questions.map((question, index) => ({
    id: question.id.trim() || `question-${index + 1}`,
    header: question.header.trim() || "Question",
    question: question.question.trim() || "Choose an answer.",
    options: (question.options ?? []).map((option, optionIndex) => ({
      label: option.label.trim() || `Option ${optionIndex + 1}`,
      description: option.description.trim() || option.label.trim() || `Option ${optionIndex + 1}`,
    })),
    allowCustomAnswer: question.isOther ?? false,
    native: {
      isBlocking,
      ...(question.isSecret === undefined ? {} : { isSecret: question.isSecret }),
    },
  }));
}
